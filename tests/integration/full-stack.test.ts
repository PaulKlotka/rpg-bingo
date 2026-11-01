import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { HubService } from '../../integrations/between-turns/functions/src/service';
import { FirestoreStore } from '../../integrations/between-turns/functions/src/store';
import type { GameCommand, SessionView, Grant } from '../../integrations/between-turns/shared/types';
import { CentralRewards } from '../../integrations/rpg-rewards/functions/src/central-service';
import type { HubGateway, HubContext } from '../../integrations/rpg-rewards/functions/src/hub-gateway';
import { EmbeddedService } from '../../functions/src/embedded-service';
import type { IntegrationGateway } from '../../functions/src/integration-gateway';
import type { CentralContext, RewardOffer, EmbeddedRun } from '../../functions/src/shared/embedded';

if (!process.env.FIRESTORE_EMULATOR_HOST?.match(/^(127\.0\.0\.1|localhost):\d+$/)) throw new Error('Use a local Firestore emulator.');
const hubRequire = createRequire(new URL('../../integrations/between-turns/functions/package.json', import.meta.url));
const bingoRequire = createRequire(new URL('../../functions/package.json', import.meta.url));
const rewardRequire = createRequire(new URL('../../integrations/rpg-rewards/functions/package.json', import.meta.url));
const hubApp = hubRequire('firebase-admin/app').initializeApp({ projectId: 'demo-integrated-hub' });
const bingoApp = bingoRequire('firebase-admin/app').initializeApp({ projectId: 'demo-integrated-bingo' }, 'full-stack');
const rewardApp = rewardRequire('firebase-admin/app').initializeApp({ projectId: 'demo-integrated-rewards' }, 'full-stack');
const bingoDb = bingoRequire('firebase-admin/firestore').getFirestore(bingoApp);
const rewardDb = rewardRequire('firebase-admin/firestore').getFirestore(rewardApp);
after(async () => { await Promise.all([hubRequire('firebase-admin/app').deleteApp(hubApp), bingoRequire('firebase-admin/app').deleteApp(bingoApp), rewardRequire('firebase-admin/app').deleteApp(rewardApp)]); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  let now = 1000; const prefix = randomUUID(); const a = `a-${prefix}`; const b = `b-${prefix}`;
  const hub = new HubService(new FirestoreStore(), [{ id: 'rpg-bingo', name: 'Bingo', description: 'Bingo', ready: true, embedUrl: 'https://bingo.example/embed' }], [
    { id: 'rpg-bingo', kind: 'game', origin: 'https://bingo.example' }, { id: 'rpg-rewards', kind: 'rewards', origin: 'https://rewards.example', embedUrl: 'https://rewards.example/embed' },
  ], () => now);
  const rh: HubGateway = {
    exchange: async (token, nonce) => hub.game('rpg-rewards', { action: 'exchange', token, nonce }) as Promise<HubContext>,
    context: async (sessionId, playerId, runId, gameId) => hub.game('rpg-rewards', { action: 'context', sessionId, playerId, ...(runId ? { runId, gameId } : {}) }) as Promise<HubContext>,
    activity: async (sessionId, playerId, eventId) => hub.game('rpg-rewards', { action: 'activity', sessionId, playerId, eventId }),
  };
  const rewards = new CentralRewards(rewardDb, rh, () => now);
  let loseSettlement = false;
  const gateway: IntegrationGateway = {
    exchange: async (token, nonce) => hub.game('rpg-bingo', { action: 'exchange', token, nonce }) as Promise<CentralContext>,
    context: async c => hub.game('rpg-bingo', { action: 'context', sessionId: c.sessionId, playerId: c.playerId, runId: c.runId }) as Promise<CentralContext>,
    activity: async (c, eventId) => hub.game('rpg-bingo', { action: 'activity', sessionId: c.sessionId, playerId: c.playerId, runId: c.runId, eventId }),
    draw: async c => rewards.game('rpg-bingo', { action: 'draw', sessionId: c.sessionId, playerId: c.playerId, runId: c.runId, requestId: hash(`offer/${c.runId}`) }) as Promise<RewardOffer>,
    settle: async (c, offerId, winnerIds) => {
      const result = await rewards.game('rpg-bingo', { action: 'settle', sessionId: c.sessionId, runId: c.runId, offerId, winnerIds, requestId: hash(`settle/${c.runId}`) });
      if (loseSettlement) { loseSettlement = false; throw new Error('Lost response after committed Rewards settlement'); }
      return result as { receipt: string };
    },
    complete: async (c, eventId, winnerIds, rewardsReceipt) => hub.game('rpg-bingo', { action: 'complete', sessionId: c.sessionId, runId: c.runId, eventId, winnerIds, rewardsReceipt }),
  };
  const bingo = new EmbeddedService(bingoDb, gateway, () => now);
  const first = await hub.player(a, { action: 'create', name: 'Alpha', requestId: randomUUID() }) as SessionView;
  const sessionId = first.session.id;
  await hub.player(b, { action: 'join', code: first.session.code, name: 'Beta', requestId: randomUUID() });
  await hub.player(a, { action: 'start', sessionId, requestId: randomUUID() });
  const current = await hub.player(a, { action: 'current' }) as SessionView; const runId = current.session.run!.id;
  async function connect(playerId: string, appId: string) {
    const nonce = randomUUID(); const service = appId === 'rpg-bingo' ? bingo : rewards;
    const { credential } = await service.begin(nonce);
    const grant = await hub.player(playerId, { action: 'connect', sessionId, appId, nonce, ...(appId === 'rpg-bingo' ? { runId } : {}) }) as Grant;
    await service.connect(credential, nonce, grant.token); return credential;
  }
  const ac = await connect(a, 'rpg-bingo'); const bc = await connect(b, 'rpg-bingo');
  const ar = await connect(a, 'rpg-rewards'); const br = await connect(b, 'rpg-rewards');
  const ref = bingoDb.doc(`embeddedRuns/${hash(`${sessionId}/${runId}`)}`);
  const run = (await ref.get()).data() as EmbeddedRun;
  const card = Array.from({ length: 25 }, (_, i) => i === 12 ? null : i % 20 + 1);
  await ref.update({ pattern: 'single-line', marks: [1, 2, 3, 4], players: Object.fromEntries(Object.entries(run.players).map(([id, p]) => [id, { ...p, card }])) });
  return { hub, rewards, bingo, gateway, a, b, ac, bc, ar, br, ref, sessionId, runId, advance: (value: number) => { now = value; }, lose: () => { loseSettlement = true; }, now: () => now };
}
test('real hub, Bingo and Rewards complete a tied game, recover settlement, start a new run and preserve inventory', async () => {
  const f = await fixture();
  const start = await f.bingo.command(f.ac, { action: 'view' });
  const won = await f.bingo.command(f.ac, { action: 'roll', kind: 'physical', number: 5, requestId: 'win', revision: start.revision });
  assert.equal(won.phase, 'review'); assert.deepEqual(new Set(won.winners), new Set([f.a, f.b]));
  f.advance(15000);
  await f.bingo.command(f.ac, { action: 'undo', requestId: 'undo', revision: won.revision });
  const undone = await f.bingo.command(f.bc, { action: 'view' }); assert.equal(undone.phase, 'playing');
  await f.bingo.command(f.bc, { action: 'roll', kind: 'physical', number: 5, requestId: 'win-again', revision: undone.revision });
  f.advance(30000); f.lose();
  const c: CentralContext = { version: 1, playerId: f.a, displayName: 'Alpha', sessionId: f.sessionId, runId: f.runId, expiresAt: 0 };
  await assert.rejects(f.bingo.progress(c), /Lost response/);
  const restarted = new EmbeddedService(bingoDb, f.gateway, f.now); await restarted.progress(c);
  const next = await f.hub.player(f.a, { action: 'current' }) as SessionView;
  assert.notEqual(next.session.run!.id, f.runId); assert.equal(next.session.history.length, 1);
  const inventory = await f.rewards.player(f.ar, { action: 'view' });
  assert.equal(inventory.inventory.length, 1); assert.equal(inventory.history.length, 2);
  assert.deepEqual(inventory.inventory[0].reward, start.offer!.reward);
  const awardId = inventory.inventory[0].id;
  await assert.rejects(f.rewards.player(f.br, { action: 'consume', awardId, consumed: true, requestId: 'steal' }), /another player/);
  const used = await f.rewards.player(f.ar, { action: 'consume', awardId, consumed: true, requestId: 'use' }); assert.notEqual(used.inventory[0].consumedAt, null);
  const unused = await f.rewards.player(f.ar, { action: 'consume', awardId, consumed: false, requestId: 'undo-use' }); assert.equal(unused.inventory[0].consumedAt, null);
  await assert.rejects(restarted.command(f.ac, { action: 'view' }), /active/);
});
test('Rewards rejects the wrong run and departed members, with no independently created session', async () => {
  const f = await fixture();
  await assert.rejects(f.rewards.game('rpg-bingo', { action: 'draw', sessionId: f.sessionId, playerId: f.a, runId: 'wrong-run', requestId: 'wrong' }), /active/);
  await f.hub.player(f.b, { action: 'leave', sessionId: f.sessionId, requestId: randomUUID() });
  await assert.rejects(f.rewards.player(f.br, { action: 'view' }), /no longer/);
  assert.equal((await rewardDb.doc(`sessions/${f.sessionId}`).get()).exists, false);
  f.advance(86_400_000 + 1001);
  await assert.rejects(f.rewards.player(f.ar, { action: 'view' }));
});
