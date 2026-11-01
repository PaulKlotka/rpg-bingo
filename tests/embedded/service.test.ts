import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { EmbeddedService } from '../../functions/src/embedded-service';
import type { IntegrationGateway } from '../../functions/src/integration-gateway';
import type { CentralContext, EmbeddedRun } from '../../functions/src/shared/embedded';

if (!process.env.FIRESTORE_EMULATOR_HOST?.match(/^(127\.0\.0\.1|localhost):\d+$/)) throw new Error('Run only against a local Firestore emulator.');
const serverRequire = createRequire(new URL('../../functions/package.json', import.meta.url));
const adminApp = serverRequire('firebase-admin/app').initializeApp({ projectId: 'demo-rpg-games' }, `embedded-${randomUUID()}`);
const db = serverRequire('firebase-admin/firestore').getFirestore(adminApp);
after(() => serverRequire('firebase-admin/app').deleteApp(adminApp));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

class Gateway implements IntegrationGateway {
  c: CentralContext = { version: 1, playerId: 'a', displayName: 'Alpha', sessionId: randomUUID(), runId: randomUUID(), expiresAt: 86_400_000 };
  members = new Set(['a', 'b']); grants = new Set<string>(); calls: string[] = [];
  offers = new Set<string>(); settlements = new Set<string>(); completions = new Set<string>(); activities = new Set<string>();
  failSettlement = false; loseSettlementResponse = false; loseCompletionResponse = false; failActivity = false;
  async exchange(token: string, nonce: string) {
    assert.equal(nonce, 'nonce'); assert.ok(!this.grants.has(token)); this.grants.add(token);
    return { ...this.c, playerId: token, displayName: token === 'a' ? 'Alpha' : 'Beta' };
  }
  async context(c: CentralContext) {
    if (!this.members.has(c.playerId)) throw Object.assign(new Error('Departed'), { response: { data: { error: { code: 'permission-denied' } } } });
    if (this.completions.has(c.runId)) throw new Error('Old run');
    assert.equal(c.sessionId, this.c.sessionId); assert.equal(c.runId, this.c.runId);
    return { ...c, expiresAt: this.c.expiresAt };
  }
  async activity(c: CentralContext, eventId: string) {
    this.calls.push('activity');
    if (this.failActivity) throw new Error('Hub offline');
    this.activities.add(eventId); return { accepted: true };
  }
  async draw(c: CentralContext) {
    this.calls.push('draw'); this.offers.add(c.runId);
    return { id: `offer-${c.runId}`, reward: { id: 'external', name: 'Rewards chooses this', qualifyingRoll: 'A qualifying roll' } };
  }
  async settle(c: CentralContext, offerId: string, winnerIds: string[]) {
    this.calls.push('settle');
    if (this.failSettlement) throw new Error('Rewards offline');
    assert.equal(offerId, `offer-${c.runId}`); assert.ok(winnerIds.length);
    this.settlements.add(c.runId);
    if (this.loseSettlementResponse) { this.loseSettlementResponse = false; throw new Error('Response lost after award'); }
    return { receipt: `receipt-${c.runId}` };
  }
  async complete(c: CentralContext, eventId: string, winnerIds: string[], receipt: string) {
    this.calls.push('complete'); assert.ok(this.settlements.has(c.runId)); assert.equal(receipt, `receipt-${c.runId}`);
    this.completions.add(c.runId);
    if (this.loseCompletionResponse) { this.loseCompletionResponse = false; throw new Error('Response lost after completion'); }
    return { accepted: true };
  }
}
async function fixture(twoPlayers = true) {
  const gateway = new Gateway(); let now = 1000;
  const service = new EmbeddedService(db, gateway, () => now);
  const a = await service.begin('nonce'); const first = await service.connect(a.credential, 'nonce', 'a');
  const b = await service.begin('nonce'); if (twoPlayers) await service.connect(b.credential, 'nonce', 'b');
  const ref = db.doc(`embeddedRuns/${hash(`${gateway.c.sessionId}/${gateway.c.runId}`)}`);
  const run = (await ref.get()).data() as EmbeddedRun;
  const card = Array.from({ length: 25 }, (_, i) => i === 12 ? null : i % 20 + 1);
  await ref.update({ pattern: 'single-line', players: Object.fromEntries(Object.entries(run.players).map(([id, p]) => [id, { ...p, card }])) });
  const read = async () => (await ref.get()).data() as EmbeddedRun;
  return { service, gateway, a: a.credential, b: b.credential, first, ref, read, advance: (time: number) => { now = time; } };
}
async function win(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ref.update({ marks: [1, 2, 3, 4] });
  const run = await f.read();
  await f.service.command(f.a, { action: 'roll', kind: 'physical', number: 5, requestId: randomUUID(), revision: run.revision });
  f.advance(16000);
}
test('server-bound grants, run reuse, card privacy, reload and late membership', async () => {
  const f = await fixture();
  assert.equal(f.gateway.offers.size, 1);
  const view = await f.service.command(f.a, { action: 'view', playerId: 'b', sessionId: 'forged' });
  assert.equal(view.playerId, 'a'); assert.ok(view.card); assert.equal('card' in view.players[1], false);
  const saved = [...view.card];
  const c = await f.service.begin('nonce');
  // A repeated grant cannot change the identity already bound to a connection.
  await assert.rejects(f.service.connect(f.a, 'nonce', 'b'), /fresh frame/);
  await assert.rejects(f.service.connect(c.credential, 'wrong', 'a'), /fresh frame/);
  assert.deepEqual((await f.service.command(f.a, { action: 'view' })).card, saved);
  assert.equal(f.gateway.activities.size, 0);
  f.gateway.members.delete('a');
  await assert.rejects(f.service.command(f.a, { action: 'view' }), /Departed/);
});
test('concurrent duplicate moves are one accepted roll; payload reuse and stale revisions reject', async () => {
  const f = await fixture(); const run = await f.read();
  const move = { action: 'roll', kind: 'virtual', requestId: 'roll', revision: run.revision };
  await Promise.all([f.service.command(f.a, move), f.service.command(f.a, move)]);
  assert.equal((await f.read()).rolls, 1); assert.equal(f.gateway.activities.size, 1);
  await assert.rejects(f.service.command(f.a, { ...move, kind: 'physical', number: 1 }), /reused/);
  await assert.rejects(f.service.command(f.b, { ...move, requestId: 'stale' }), /game changed/);
});
test('accepted activity survives a backend restart and is retried without another roll', async () => {
  const f = await fixture(false); f.gateway.failActivity = true;
  const move = { action: 'roll', kind: 'physical', number: 1, requestId: 'roll', revision: (await f.read()).revision };
  await assert.rejects(f.service.command(f.a, move), /offline/);
  assert.equal((await f.read()).rolls, 1);
  f.gateway.failActivity = false;
  const restarted = new EmbeddedService(db, f.gateway, () => 1001);
  await restarted.command(f.a, move);
  assert.equal((await f.read()).rolls, 1); assert.equal(f.gateway.activities.size, 1);
});
test('undo cancels a tied win before its server deadline; confirmation never redeals', async () => {
  const f = await fixture(); await win(f);
  assert.equal((await f.read()).phase, 'review');
  f.advance(15999);
  await f.service.command(f.a, { action: 'undo', requestId: 'undo', revision: (await f.read()).revision });
  assert.equal((await f.read()).phase, 'playing'); assert.equal(f.gateway.settlements.size, 0);
  await win(f); // distinct request ID for a later accepted roll
});
test('settlement outage locks cards, retries tied awards once, then completes through the hub', async () => {
  const f = await fixture(); await win(f); const before = await f.read();
  f.gateway.failSettlement = true;
  await assert.rejects(f.service.command(f.a, { action: 'view' }), /offline/);
  assert.equal((await f.read()).phase, 'settling'); assert.equal(f.gateway.completions.size, 0);
  f.gateway.failSettlement = false; f.gateway.loseSettlementResponse = true;
  const restarted = new EmbeddedService(db, f.gateway, () => 16001);
  await assert.rejects(restarted.progress(f.gateway.c), /Response lost/);
  await restarted.progress(f.gateway.c);
  const after = await f.read();
  assert.equal(after.phase, 'complete'); assert.deepEqual(after.players, before.players);
  assert.deepEqual(after.settlement?.winnerIds, ['a', 'b']); assert.equal(f.gateway.settlements.size, 1);
  assert.equal(f.gateway.completions.size, 1); assert.equal(f.gateway.offers.size, 1);
  assert.equal(f.gateway.calls.at(-1), 'complete');
  await assert.rejects(restarted.command(f.a, { action: 'view' }), /Old run/);
});
test('a lost hub completion response is retried from the saved Rewards receipt', async () => {
  const f = await fixture(); await win(f); f.gateway.loseCompletionResponse = true;
  await assert.rejects(f.service.progress(f.gateway.c), /Response lost/);
  const settlementCalls = f.gateway.calls.filter(x => x === 'settle').length;
  const restarted = new EmbeddedService(db, f.gateway, () => 16001);
  await restarted.progress(f.gateway.c);
  assert.equal((await f.read()).phase, 'complete'); assert.equal(f.gateway.completions.size, 1);
  assert.equal(f.gateway.calls.filter(x => x === 'settle').length, settlementCalls);
});
test('a departed winner cannot be awarded or complete a run', async () => {
  const f = await fixture(); await win(f); f.gateway.members.delete('b');
  await assert.rejects(f.service.progress(f.gateway.c), /Departed/);
  assert.equal(f.gateway.settlements.size, 0); assert.equal(f.gateway.completions.size, 0);
});
test('late entry during review receives a card without changing the confirmed winner candidates', async () => {
  const f = await fixture(false); await win(f);
  f.advance(15999);
  const view = await f.service.connect(f.b, 'nonce', 'b');
  assert.ok(view.card); assert.equal(view.phase, 'review');
  assert.deepEqual(view.pending?.winnerIds, ['a']);
  assert.deepEqual(view.marks, [1, 2, 3, 4, 5]);
});
test('expired browser credentials fail closed without creating another offer', async () => {
  const f = await fixture(false); f.advance(3_601_001);
  await assert.rejects(f.service.command(f.a, { action: 'view' }), /reconnect/);
  assert.equal(f.gateway.offers.size, 1);
});
test('a departed peer cannot block the remaining player from taking another turn', async () => {
  const f = await fixture();
  await f.service.command(f.a, { action: 'roll', kind: 'physical', number: 1, requestId: 'first', revision: (await f.read()).revision });
  f.gateway.members.delete('b');
  await f.service.command(f.a, { action: 'roll', kind: 'physical', number: 2, requestId: 'after-departure', revision: (await f.read()).revision });
  assert.deepEqual((await f.read()).marks, [1, 2]);
  assert.deepEqual(Object.keys((await f.read()).players), ['a']);
});
