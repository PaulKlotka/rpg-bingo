import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { HubService } from '../../functions/src/service';
import { FirestoreStore } from '../../functions/src/store';
import { SESSION_TTL, type SessionView, type Grant } from '../../shared/types';
const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = requireFunctions('firebase-admin/app') as typeof import('firebase-admin/app');
before(() => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Run only against disposable emulators.');
  if (!admin.getApps().length) admin.initializeApp({ projectId: 'demo-between-turns' });
});
const req = () => randomUUID();
function setup() {
  const uid = `test-${req()}`; let clock = Date.now();
  const games = ['bingo', 'dice', 'cards'].map(id => ({ id, name: id, description: id, ready: true }));
  const apps = [{ id: 'bingo', kind: 'game' as const, origin: 'https://bingo.example.com' }, { id: 'rpg-rewards', kind: 'rewards' as const, origin: 'https://rewards.example.com' }];
  return { uid, service: new HubService(new FirestoreStore(), games, apps, () => clock, () => 0), advance: (ms: number) => { clock += ms; } };
}
test('Firestore transaction enforces concurrent unique-name joins and single membership', async () => {
  const { uid, service } = setup();
  const a = await service.player(uid, { action: 'create', name: 'Alice', requestId: req() }) as SessionView;
  const results = await Promise.allSettled(['x', 'y'].map(suffix => service.player(`${uid}-${suffix}`, { action: 'join', code: a.session.code, name: 'Same', requestId: req() })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const b = await service.player(`${uid}-host`, { action: 'create', name: 'Host', requestId: req() }) as SessionView;
  await Promise.all([a, b].map(v => service.player(`${uid}-switch`, { action: 'join', code: v.session.code, name: 'Switch', requestId: req() })));
  const views = await Promise.all([uid, `${uid}-host`].map(player => service.player(player, { action: 'current' }) as Promise<SessionView>));
  assert.equal(views.flatMap(v => v.session.members).filter(m => m.id === `${uid}-switch`).length, 1);
});
test('Firestore voting closes atomically when all eligible players vote', async () => {
  const { uid, service } = setup(); const bob = `${uid}-bob`;
  const a = await service.player(uid, { action: 'create', name: 'Alice', requestId: req() }) as SessionView;
  await service.player(bob, { action: 'join', code: a.session.code, name: 'Bob', requestId: req() });
  await service.player(bob, { action: 'presence', sessionId: a.session.id, connectionId: req(), connected: true });
  const vote = await service.player(uid, { action: 'start', sessionId: a.session.id, requestId: req() }) as SessionView;
  await Promise.all([uid, bob].map(player => service.player(player, { action: 'vote', sessionId: a.session.id, ballotId: vote.session.ballot!.id, gameId: 'bingo', requestId: req() })));
  const result = await service.player(uid, { action: 'current' }) as SessionView;
  assert.equal(result.session.phase, 'playing'); assert.equal(result.session.run!.gameId, 'bingo');
});
test('Firestore completion retries, atomic grant consumption, and expiration', async () => {
  const { uid, service, advance } = setup(); const a = await service.player(uid, { action: 'create', name: 'Alice', requestId: req() }) as SessionView;
  const grant = await service.player(uid, { action: 'connect', sessionId: a.session.id, appId: 'rpg-rewards', nonce: 'test-nonce' }) as Grant;
  const exchanges = await Promise.allSettled([1, 2].map(() => service.game('rpg-rewards', { action: 'exchange', token: grant.token, nonce: 'test-nonce' })));
  assert.equal(exchanges.filter(r => r.status === 'fulfilled').length, 1);
  const voting = await service.player(uid, { action: 'start', sessionId: a.session.id, requestId: req() }) as SessionView;
  const playing = await service.player(uid, { action: 'vote', sessionId: a.session.id, ballotId: voting.session.ballot!.id, gameId: 'bingo', requestId: req() }) as SessionView;
  const complete = { action: 'complete' as const, sessionId: a.session.id, runId: playing.session.run!.id, eventId: req(), winnerIds: [uid], rewardsReceipt: 'settled' };
  await Promise.all([service.game('bingo', complete), service.game('bingo', complete)]);
  const next = await service.player(uid, { action: 'current' }) as SessionView; assert.equal(next.session.history.length, 1); assert.equal(next.session.phase, 'voting');
  advance(SESSION_TTL); await assert.rejects(service.game('bingo', { action: 'activity', sessionId: a.session.id, playerId: uid, runId: playing.session.run!.id, eventId: req() }), /expired/);
});
test('deployed-shape callable requires authentication and Firestore denies browser reads/writes', async () => {
  const host = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5201';
  const response = await fetch(`http://${host}/demo-between-turns/us-central1/playerCommand`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { action: 'current' } }) });
  assert.equal(response.status, 401);
  const firestore = process.env.FIRESTORE_EMULATOR_HOST!;
  const url = `http://${firestore}/v1/projects/demo-between-turns/databases/(default)/documents/sessions/forbidden`;
  const write = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { phase: { stringValue: 'playing' } } }) });
  assert.equal(write.status, 403);
  const read = await fetch(url); assert.equal(read.status, 403);
});
