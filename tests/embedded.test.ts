import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMove, confirmRun, type EmbeddedRun } from '../functions/src/shared/embedded';
import { acceptsConnection } from '../src/embed-bridge';

function fixture(): EmbeddedRun {
  const card = Array.from({ length: 25 }, (_, i) => i === 12 ? null : i % 20 + 1);
  return { sessionId: 'session', runId: 'run', phase: 'playing', pattern: 'single-line', offer: { id: 'offer', reward: { id: 'external', name: 'From Rewards', qualifyingRoll: 'A roll' } },
    offerPlayerId: 'a', revision: 0, marks: [], rolls: 0, players: { a: { name: 'Alpha', card }, b: { name: 'Beta', card } }, last: null, undo: null, pending: null, settlement: null };
}
test('one central run shares marks, alternates submitters and permits solo play', () => {
  const run = applyMove(fixture(), 'a', { action: 'roll', number: 1 }, 'event', ['a', 'b'], 0);
  assert.deepEqual(run.marks, [1]);
  assert.throws(() => applyMove(run, 'a', { action: 'roll', number: 2 }, 'event2', ['a', 'b'], 0), /Another player/);
  assert.equal(applyMove(run, 'a', { action: 'roll', number: 2 }, 'event2', ['a'], 0).rolls, 2);
  assert.throws(() => applyMove(run, 'c', { action: 'roll', number: 2 }, 'event2', ['a', 'b'], 0), /no longer/);
});
test('server-detected tied winners stay frozen through review and settle once without a new card', () => {
  const run = { ...fixture(), marks: [1, 2, 3, 4] };
  const won = applyMove(run, 'a', { action: 'roll', number: 5 }, 'winning', ['a', 'b'], 1000);
  assert.equal(won.phase, 'review'); assert.deepEqual(won.pending?.winnerIds, ['a', 'b']);
  assert.throws(() => applyMove(won, 'b', { action: 'roll', number: 6 }, 'later', ['a', 'b'], 2000), /locked/);
  assert.equal(confirmRun(won, 15999), won);
  const settled = confirmRun(won, 16000);
  assert.equal(settled.phase, 'settling'); assert.equal(settled.players, won.players);
  assert.equal(settled.offer, won.offer); assert.equal(confirmRun(settled, 20000), settled);
  assert.throws(() => applyMove(settled, 'a', { action: 'undo' }, 'undo', ['a', 'b'], 16001), /awaiting/);
});
test('undo cancels review only before its deadline and restores repeated marks', () => {
  const won = applyMove({ ...fixture(), marks: [1, 2, 3, 4] }, 'a', { action: 'roll', number: 5 }, 'win', ['a', 'b'], 0);
  const restored = applyMove(won, 'a', { action: 'undo' }, 'undo', ['a', 'b'], 14999);
  assert.equal(restored.phase, 'playing'); assert.equal(restored.pending, null); assert.deepEqual(restored.marks, [1, 2, 3, 4]);
  assert.throws(() => applyMove(won, 'a', { action: 'undo' }, 'undo', ['a', 'b'], 15000), /review ends/);
  const repeated = applyMove({ ...fixture(), marks: [1] }, 'a', { action: 'roll', number: 1 }, 'repeat', ['a', 'b'], 0);
  assert.deepEqual(applyMove(repeated, 'a', { action: 'undo' }, 'undo', ['a', 'b'], 1).marks, [1]);
});
test('departed players cannot win and arbitrary rolls are rejected', () => {
  const won = applyMove({ ...fixture(), marks: [1, 2, 3, 4] }, 'a', { action: 'roll', number: 5 }, 'win', ['a'], 0);
  assert.deepEqual(won.pending?.winnerIds, ['a']);
  for (const number of [0, 21, 1.5, NaN]) assert.throws(() => applyMove(fixture(), 'a', { action: 'roll', number }, 'bad', ['a'], 0), /1 to 20/);
});
test('iframe grants require exact parent, origin, nonce, version and unexpired grant', () => {
  const source = {} as Window;
  const event = { source, origin: 'https://hub.example', data: { channel: 'between-turns', version: 1, type: 'connect', nonce: 'nonce', grant: 'secret', expiresAt: 100 } };
  const accept = (candidate: typeof event) => acceptsConnection(candidate, event.origin, source, 'nonce', 99);
  assert.equal(accept(event), true);
  assert.equal(accept({ ...event, source: {} as Window }), false);
  assert.equal(accept({ ...event, origin: 'https://evil.example' }), false);
  for (const patch of [{ nonce: 'other' }, { version: 2 }, { type: 'win' }, { expiresAt: 99 }, { grant: '' }]) assert.equal(accept({ ...event, data: { ...event.data, ...patch } }), false);
});
