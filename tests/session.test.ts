import assert from 'node:assert/strict';
import test from 'node:test';
import { isMarked } from '../src/game';
import { loadSession, newSession, nextCard, playNumber, restoreSession, rollSession, saveSession, serializeSession, STORAGE_KEY, toggleAward, type Session } from '../src/session';

// Synthetic legacy cards isolate awards and restoration from generated layouts.
const fixtureExpiry = Date.now() + 86400000;
const fixture = (session: Session): Session => ({ ...session, expiresAt: fixtureExpiry, game: { ...session.game, pattern: 'single-line', card: Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1) } });
const fresh = () => fixture(newSession(() => 0, () => 0, () => 'first-card'));
const win = () => playNumber(fresh(), 1);

test('an offered prize is not in the won-prizes list', () => {
  const initial = fresh();
  assert.equal(initial.game.prize.name, 'Steady Aim');
  assert.equal(initial.awards.length, 0);
  assert.equal(rollSession(initial, () => .975).awards.length, 0);
});

test('a manual win awards exactly once despite continued rolls and locked taps', () => {
  const winner = win();
  assert.equal(winner.awards.length, 1);
  assert.deepEqual(winner.awards[0], { id: 'first-card', prize: winner.game.prize, used: false });
  let next = playNumber(winner, 1);
  for (let i = 0; i < 10; i++) next = rollSession(next, () => .975);
  assert.equal(next.awards.length, 1);
  assert.equal(next.game.marked, winner.game.marked);
});

test('a die roll that wins also creates one earned instance', () => {
  const winner = rollSession(fresh(), () => 0);
  assert.equal(winner.game.won, true);
  assert.equal(winner.awards.length, 1);
});

test('New Card preserves prizes and used flags; duplicate prize wins stay independent', () => {
  const used = toggleAward(win(), 'first-card');
  const next = fixture(nextCard(used, () => 0, () => 0, () => 'second-card'));
  assert.equal(next.game.won, false);
  assert.equal(next.awards.length, 1);
  assert.equal(next.awards[0].used, true);
  const secondWin = playNumber(next, 1);
  assert.equal(secondWin.awards.length, 2);
  assert.equal(secondWin.awards[0].prize, secondWin.awards[1].prize);
  assert.notEqual(secondWin.awards[0].id, secondWin.awards[1].id);
  assert.deepEqual(secondWin.awards.map(a => a.used), [true, false]);
  const bothUsed = toggleAward(secondWin, 'second-card');
  const undone = toggleAward(bothUsed, 'first-card');
  assert.deepEqual(undone.awards.map(a => a.used), [false, true]);
  assert.equal(undone.game, secondWin.game);
});

test('in-progress card, roll, marks and prize survive serialization', () => {
  let session = newSession(() => .975, () => .575, () => 'progress-card');
  session = rollSession(session, () => .15); // one rolled number leaves the card playable
  const restored = restoreSession(serializeSession(session));
  assert.deepEqual(restored, session);
  assert.equal(isMarked(restored!.game, 12), true);
  assert.equal(restored!.game.prize.name, 'Access Granted');
  assert.equal(restored!.game.won, false);
});

test('partial grouped marks are restored and can be toggled off', () => {
  const initial = fresh();
  const card = initial.game.card.map((n, i) => i === 0 ? 2 : n);
  const partial = playNumber({ ...initial, game: { ...initial.game, card } }, 2);
  const restored = restoreSession(serializeSession(partial))!;
  assert.equal(isMarked(restored.game, 0), true);
  assert.equal(restored.game.won, false);
  assert.equal(isMarked(playNumber(restored, 2).game, 0), false);
});

test('won lock, winning lines, earned IDs and used flags survive reload without duplicate awards', () => {
  const used = toggleAward(win(), 'first-card');
  const restored = restoreSession(serializeSession(used))!;
  assert.deepEqual(restored, used);
  assert.equal(restored.game.won, true);
  assert.equal(restored.game.winningLines.length, 12);
  const afterRoll = rollSession(restored, () => .975);
  assert.equal(afterRoll.awards.length, 1);
  assert.equal(afterRoll.awards[0].used, true);
  assert.equal(afterRoll.game.marked, restored.game.marked);
});

test('reload retains prizes from previous cards while current offer remains unearned', () => {
  const session = nextCard(toggleAward(win(), 'first-card'), () => .975, () => .975, () => 'next-card');
  const restored = restoreSession(serializeSession(session))!;
  assert.deepEqual(restored, session);
  assert.equal(restored.awards.length, 1);
  assert.equal(restored.game.won, false);
  assert.equal(restored.game.prize.name, 'Trailblazer');
});

test('invalid, corrupt and inconsistent saved progress is rejected', () => {
  assert.equal(restoreSession('not json'), null);
  for (const raw of ['null', '[]', '{}', '{"version":2}']) assert.equal(restoreSession(raw), null);
  const invalidChanges = [
    (s: any) => { s.version = 2; },
    (s: any) => { s.game.card[0] = 21; },
    (s: any) => { s.game.card[12] = 1; },
    (s: any) => { s.game.card.pop(); },
    (s: any) => { s.game.marked = [1, 1]; },
    (s: any) => { s.game.marked = [0]; },
    (s: any) => { s.game.won = false; },
    (s: any) => { s.game.prize = 'Unknown prize'; },
    (s: any) => { s.game.rolls = -1; },
    (s: any) => { s.game.lastRoll = 20; },
    (s: any) => { s.awards = []; },
    (s: any) => { s.awards[0].prize = 'Trailblazer'; },
    (s: any) => { s.awards.push(s.awards[0]); },
    (s: any) => { s.awards[0].used = 'yes'; },
  ];
  for (const change of invalidChanges) {
    const saved = JSON.parse(serializeSession(win()));
    change(saved);
    assert.equal(restoreSession(JSON.stringify(saved)), null);
  }
  const falseAward = JSON.parse(serializeSession(fresh()));
  falseAward.awards = [{ id: 'first-card', prize: 'Steady Aim', used: false }];
  assert.equal(restoreSession(JSON.stringify(falseAward)), null);
});

test('load/save handles unavailable, corrupt and quota-blocked storage gracefully', () => {
  const initial = win();
  let raw = '';
  const storage = {
    getItem: (key: string) => { assert.equal(key, STORAGE_KEY); return raw; },
    setItem: (key: string, value: string) => { assert.equal(key, STORAGE_KEY); raw = value; },
  };
  assert.equal(saveSession(initial, storage), true);
  assert.deepEqual(loadSession(storage), initial);
  assert.equal(saveSession(initial, undefined), false);
  assert.equal(saveSession(initial, { setItem() { throw new Error('QuotaExceededError'); } }), false);
  assert.deepEqual(loadSession(undefined, fresh), fresh());
  assert.deepEqual(loadSession({ getItem() { throw new Error('SecurityError'); } }, fresh), fresh());
  raw = '{broken';
  assert.deepEqual(loadSession(storage, fresh), fresh());
});
