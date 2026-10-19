import assert from 'node:assert/strict';
import test from 'node:test';
import { newGame, roll, toggleNumber } from '../src/game';
import { PRIZES, selectPrize } from '../src/prizes';

// Synthetic legacy card isolates prize behavior from the random board layout.
const fixture = (prizeRandom: () => number) => ({ ...newGame(() => 0, prizeRandom), pattern: 'single-line', card: Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1) });

test('all 20 agreed prizes are independently selectable, including the endpoints', () => {
  const expected = [
    ['Steady Aim', 'ranged attack roll'],
    ['Close Encounter', 'melee attack roll'],
    ['Quick Start', 'initiative roll'],
    ['Fast Reflexes', 'Reflex save'],
    ['Iron Constitution', 'Fortitude save'],
    ['Mental Shield', 'Will save'],
    ['Sharp Eyes', 'Perception check to spot something'],
    ['Ghost Protocol', 'check to sneak or hide'],
    ['Silver Tongue', 'check to persuade someone'],
    ['Convincing Bluff', 'check to deceive someone'],
    ['Commanding Presence', 'check to intimidate someone'],
    ['Access Granted', 'check to access or hack a computer'],
    ['Field Mechanic', 'check to repair equipment'],
    ['Precision Tools', 'check to pick a lock or disable a device'],
    ['Steady Hands', 'check to provide medical treatment'],
    ['Ace Pilot', 'check to operate a vehicle'],
    ['Power Through', 'check to climb, jump, or swim'],
    ['Perfect Balance', 'check to balance or tumble'],
    ['Database Recall', 'check to recall information'],
    ['Trailblazer', 'check to track or navigate through wilderness'],
  ];
  assert.equal(PRIZES.length, 20);
  assert.equal(new Set(PRIZES.map(p => p.name)).size, 20);
  expected.forEach(([name, qualifyingRoll], index) => {
    assert.deepEqual(selectPrize(() => (index + .5) / 20), { name, qualifyingRoll });
  });
  assert.equal(selectPrize(() => 0).name, 'Steady Aim');
  assert.equal(selectPrize(() => .999999).name, 'Trailblazer');
});

test('prize draws do not affect card generation, and card values do not determine prizes', () => {
  let boardCalls = 0;
  let prizeCalls = 0;
  const first = newGame(() => { boardCalls++; return 0; }, () => { prizeCalls++; return .999999; });
  assert.ok(boardCalls > 0);
  assert.equal(prizeCalls, 1);
  assert.equal(first.prize.name, 'Trailblazer');
  const sameCard = newGame(() => 0, () => 0);
  assert.deepEqual(sameCard.card, first.card);
  assert.notEqual(sameCard.prize.name, first.prize.name);
  const differentCard = newGame(() => .999999, () => .999999);
  assert.notDeepEqual(differentCard.card, first.card);
  assert.deepEqual(differentCard.prize, first.prize);
});

test('offered prize stays fixed through toggles, rolls, win, and post-win rolls', () => {
  const initial = fixture(() => .575);
  assert.equal(initial.prize.name, 'Access Granted');
  let game = roll(initial, () => .975); // absent number: no win
  assert.equal(game.prize, initial.prize);
  assert.equal(game.won, false);
  game = toggleNumber(game, 1);
  assert.equal(game.won, true);
  assert.equal(game.prize, initial.prize);
  game = toggleNumber(game, 1);
  game = roll(game, () => .45);
  assert.equal(game.won, true);
  assert.equal(game.prize, initial.prize);
  assert.equal(game.lastRoll, 10);
});

test('prize is preserved when rolling produces the winning mark', () => {
  const initial = fixture(() => .725);
  const winner = roll(initial, () => 0);
  assert.equal(winner.won, true);
  assert.equal(winner.prize.name, 'Steady Hands');
  assert.equal(winner.prize, initial.prize);
});

test('New Card draws another prize and resets earned state; repeats remain valid', () => {
  const winner = toggleNumber(fixture(() => 0), 1);
  const next = newGame(() => .975, () => .999999);
  assert.equal(winner.won, true);
  assert.equal(winner.prize.name, 'Steady Aim');
  assert.equal(next.prize.name, 'Trailblazer');
  assert.equal(next.won, false);
  assert.equal(next.marked.size, 0);
  const repeatedPrize = newGame(() => .5, () => .999999);
  assert.equal(repeatedPrize.prize, next.prize);
  assert.equal(repeatedPrize.won, false);
});
