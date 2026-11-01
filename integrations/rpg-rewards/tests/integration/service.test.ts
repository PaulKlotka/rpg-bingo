import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { RewardsService } from '../../functions/src/service';
import { IDLE_MS, type Award, type Offer, type SessionView } from '../../shared/model';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with npm run verify:emulators or set FIRESTORE_EMULATOR_HOST to the local emulator.');
const projectId = 'demo-rpg-rewards';
const app = initializeApp({ projectId }, `tests-${randomUUID()}`);
const db = getFirestore(app);
const clients = {
  'demo-game': { serviceAccount: 'demo-game@demo-rpg-rewards.iam.gserviceaccount.com', redirectUris: ['http://127.0.0.1:5174/callback'] },
  'other-game': { serviceAccount: 'other-game@demo-rpg-rewards.iam.gserviceaccount.com', redirectUris: ['http://127.0.0.1:5175/callback'] },
};
let now = 1_800_000_000_000;
const service = new RewardsService(db, clients, () => now, () => 0);
const player = `owner-${randomUUID()}`;
const friend = `friend-${randomUUID()}`;
const stranger = `stranger-${randomUUID()}`;
let sharedId: string;
let soloId: string;
let offer: Offer;
let award: Award;
const req = () => randomUUID();
const game = <T>(data: Record<string, unknown>, gameId = 'demo-game') => service.game(gameId, { sessionId: sharedId, playerId: player, ...data }) as Promise<T>;
const expectCode = async (work: Promise<unknown>, code: string) => assert.rejects(work, (e: any) => e.code === code);
before(async () => {
  sharedId = (await service.player(player, { action: 'create', kind: 'shared', name: 'Shared adventure', displayName: 'Paul', requestId: req() }) as any).sessionId;
  soloId = (await service.player(player, { action: 'create', kind: 'solo', name: 'Solo adventure', displayName: 'Paul', requestId: req() }) as any).sessionId;
});
after(async () => { await db.terminate(); await deleteApp(app); });

test('guest is required, and malformed commands are rejected', async () => {
  await expectCode(service.player(undefined, { action: 'list' }), 'unauthenticated');
  await expectCode(service.player(player, null), 'invalid-argument');
  await expectCode(service.player(player, { action: 'view', sessionId: '../../bad' }), 'invalid-argument');
  await expectCode(service.game('unregistered', {}), 'permission-denied');
});
test('one player can hold separate solo and shared session memberships', async () => {
  const sessions = await service.player(player, { action: 'list' }) as any[];
  assert.ok(sessions.some(s => s.id === sharedId)); assert.ok(sessions.some(s => s.id === soloId));
  await expectCode(service.player(stranger, { action: 'view', sessionId: sharedId }), 'permission-denied');
});
test('only a new shared membership extends expiration; solo joining fails', async () => {
  const original = await service.view(player, sharedId);
  const solo = await service.view(player, soloId);
  now += 1_000;
  await service.player(friend, { action: 'join', joinCode: original.session.joinCode.toLowerCase(), displayName: 'Friend' });
  assert.equal((await service.view(player, sharedId)).session.expiresAt, now + IDLE_MS);
  now += 1_000;
  await service.player(friend, { action: 'join', joinCode: original.session.joinCode, displayName: 'Another name' });
  assert.equal((await service.view(player, sharedId)).session.expiresAt, original.session.expiresAt + 1_000);
  await expectCode(service.player(friend, { action: 'join', joinCode: solo.session.joinCode, displayName: 'Friend' }), 'permission-denied');
});
test('draw is stable across concurrent retries and does not extend the timer twice', async () => {
  const input = { action: 'draw', requestId: req() };
  const results = await Promise.all([game<Offer>(input), game<Offer>(input), game<Offer>(input)]);
  offer = results[0]; results.forEach(r => assert.deepEqual(r, offer));
  assert.equal(offer.reward.name, 'Steady Aim');
  const expiry = (await service.view(player, sharedId)).session.expiresAt;
  now += 1_000;
  assert.deepEqual(await game(input), offer);
  assert.equal((await service.view(player, sharedId)).session.expiresAt, expiry);
  assert.equal((await service.view(player, sharedId)).history.length, 0);
});
test('award preserves offered reward and concurrent retries cannot duplicate it', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => game<Award>({ action: 'award', offerId: offer.id, requestId: req() })));
  award = results[0]; results.forEach(r => assert.deepEqual(r, award));
  assert.deepEqual(award.reward, offer.reward);
  assert.equal((await service.view(player, sharedId)).inventory.length, 1);
});
test('requests cannot change meaning and games cannot claim another game offer', async () => {
  const requestId = req();
  await game({ action: 'draw', requestId });
  await expectCode(game({ action: 'activity', requestId }), 'already-exists');
  await expectCode(game({ action: 'award', offerId: offer.id, requestId: req() }, 'other-game'), 'permission-denied');
  await expectCode(game({ action: 'draw', playerId: stranger, requestId: req() }), 'permission-denied');
});
test('repeated rewards are independent and different games pool in the same session', async () => {
  const second = await game<Offer>({ action: 'draw', requestId: req() }, 'other-game');
  await game({ action: 'award', offerId: second.id, requestId: req() }, 'other-game');
  const view = await service.view(player, sharedId);
  assert.equal(view.inventory.length, 2); assert.equal(new Set(view.inventory.map(a => a.gameId)).size, 2);
  assert.equal(view.inventory[0].reward.name, view.inventory[1].reward.name);
  assert.equal((await service.view(player, soloId)).inventory.length, 0);
});
test('ties can award the same offer to different members; inventory stays private', async () => {
  await game({ action: 'award', playerId: friend, offerId: offer.id, requestId: req() });
  const view = await service.view(friend, sharedId);
  assert.equal(view.inventory.length, 1); assert.equal(view.history.length, 3);
  assert.ok(view.inventory.every(a => a.playerId === friend));
});
test('only the owner can consume or undo; changes extend inactivity but no-ops and retries do not', async () => {
  await expectCode(service.player(friend, { action: 'consume', sessionId: sharedId, awardId: award.id, consumed: true, requestId: req() }), 'permission-denied');
  now += 1_000;
  const input = { action: 'consume', sessionId: sharedId, awardId: award.id, consumed: true, requestId: req() };
  await service.player(player, input);
  const expiry = now + IDLE_MS;
  assert.equal((await service.view(player, sharedId)).inventory.find(a => a.id === award.id)?.consumedAt, now);
  now += 1_000;
  await service.player(player, input);
  await service.player(player, { ...input, requestId: req() });
  assert.equal((await service.view(player, sharedId)).session.expiresAt, expiry);
  await service.player(player, { ...input, requestId: req(), consumed: false });
  assert.equal((await service.view(player, sharedId)).session.expiresAt, now + IDLE_MS);
  assert.equal((await service.view(player, sharedId)).inventory.find(a => a.id === award.id)?.consumedAt, null);
});
test('reads do not extend expiration; new gameplay activity does', async () => {
  const expiry = (await service.view(player, sharedId)).session.expiresAt;
  now += 1_000;
  await service.player(player, { action: 'list' }); await service.view(player, sharedId);
  assert.equal((await service.view(player, sharedId)).session.expiresAt, expiry);
  const input = { action: 'activity', requestId: req() };
  await game(input);
  assert.equal((await service.view(player, sharedId)).session.expiresAt, now + IDLE_MS);
  now += 1_000; await game(input);
  assert.equal((await service.view(player, sharedId)).session.expiresAt, now + IDLE_MS - 1_000);
});
test('identity handoff validates callbacks, game binding, one-time use and expiration', async () => {
  const base = { action: 'connect', sessionId: sharedId, gameId: 'demo-game', redirectUri: clients['demo-game'].redirectUris[0], state: 'csrf-state' };
  await expectCode(service.player(player, { ...base, redirectUri: 'https://evil.example/callback' }), 'permission-denied');
  const result = await service.player(player, base) as any;
  const url = new URL(result.callbackUrl); const code = url.searchParams.get('code');
  assert.equal(url.searchParams.get('state'), 'csrf-state');
  await expectCode(service.game('other-game', { action: 'exchange', code, redirectUri: base.redirectUri }), 'permission-denied');
  const redeemed = await service.game('demo-game', { action: 'exchange', code, redirectUri: base.redirectUri }) as any;
  assert.equal(redeemed.playerId, player); assert.equal(redeemed.sessionId, sharedId);
  await expectCode(service.game('demo-game', { action: 'exchange', code, redirectUri: base.redirectUri }), 'permission-denied');
  const another = await service.player(player, base) as any;
  now += 60_000;
  await expectCode(service.game('demo-game', { action: 'exchange', code: new URL(another.callbackUrl).searchParams.get('code'), redirectUri: base.redirectUri }), 'permission-denied');
});
test('expiration blocks reads, joins, draws, awards, use, undo, and gameplay before cleanup', async () => {
  const before = await service.view(player, sharedId);
  now = before.session.expiresAt;
  await expectCode(service.view(player, sharedId), 'failed-precondition');
  await expectCode(service.player(stranger, { action: 'join', joinCode: before.session.joinCode, displayName: 'Late' }), 'failed-precondition');
  for (const action of ['draw', 'award', 'activity']) await expectCode(game({ action, offerId: offer.id, requestId: req() }), 'failed-precondition');
  for (const consumed of [true, false]) await expectCode(service.player(player, { action: 'consume', sessionId: sharedId, awardId: award.id, consumed, requestId: req() }), 'failed-precondition');
  const removed = await service.cleanup(); assert.ok(removed >= 2);
  assert.equal((await db.doc(`sessions/${sharedId}`).get()).exists, false);
  assert.equal((await db.collection(`sessions/${sharedId}/awards`).get()).size, 0);
  assert.equal((await db.doc(`joinCodes/${before.session.joinCode}`).get()).exists, false);
});
