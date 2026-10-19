import assert from 'node:assert/strict';
import test from 'node:test';
import { isMarked, LINES, newGame, roll, rollD20, toggleNumber, type Game } from '../src/game';

// Synthetic legacy card exercises grouped marking and all winning lines.
function fixture(): Game {
  const card = Array.from({ length: 25 }, (_, i) => i === 12 ? null : i % 20 + 1);
  return { ...newGame(), pattern: 'single-line', card };
}

function assertDistribution(card: Game['card']) {
  assert.equal(card.length, 25);
  assert.equal(card[12], null);
  assert.equal(card.filter(n => n === null).length, 1);
  const counts = Array.from({ length: 20 }, (_, i) => card.filter(n => n === i + 1).length);
  assert.equal(counts.filter(count => count === 2).length, 4);
  assert.equal(counts.filter(count => count === 1).length, 16);
}

test('generation includes all twenty numbers with exactly four distinct duplicates', () => {
  for (const random of [() => 0, () => .999999, Math.random]) {
    const game = newGame(random);
    assertDistribution(game.card);
    assert.equal(game.marked.size, 0);
    assert.equal(isMarked(game, 12), true);
    assert.equal(game.won, false);
  }
});

test('all 20 roll values map to equal-width intervals, including both endpoints', () => {
  for (let n = 1; n <= 20; n++) assert.equal(rollD20(() => (n - .5) / 20), n);
  assert.equal(rollD20(() => 0), 1);
  assert.equal(rollD20(() => .999999), 20);
});

test('seeded samples stay in range and exercise every possible number', () => {
  let seed = 123456;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const seen = new Set<number>();
  const duplicated = new Set<number>();
  const layouts = new Set<string>();
  for (let sample = 0; sample < 100; sample++) {
    const game = newGame(random);
    assertDistribution(game.card);
    layouts.add(game.card.join());
    for (let n = 1; n <= 20; n++) if (game.card.filter(value => value === n).length === 2) duplicated.add(n);
    game.card.forEach(n => {
      if (n === null) return;
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 20);
      seen.add(n);
    });
  }
  assert.equal(seen.size, 20);
  assert.equal(duplicated.size, 20);
  assert.equal(layouts.size, 100);
});

test('manual toggle marks and unmarks all duplicates, leaving other numbers and center alone', () => {
  const initial = fixture();
  const marked = toggleNumber(initial, 1);
  assert.equal(isMarked(marked, 0), true);
  assert.equal(isMarked(marked, 20), true);
  assert.equal(isMarked(marked, 1), false);
  assert.equal(isMarked(marked, 12), true);
  assert.equal(initial.marked.size, 0);
  const unmarked = toggleNumber(marked, 1);
  assert.equal(isMarked(unmarked, 0), false);
  assert.equal(isMarked(unmarked, 20), false);
  assert.equal(isMarked(unmarked, 12), true);
});

test('roll marks all matching numbers and never unmarks on repeated rolls', () => {
  const first = roll(fixture(), () => 0);
  const second = roll(first, () => 0);
  assert.equal(isMarked(second, 0), true);
  assert.equal(isMarked(second, 20), true);
  assert.equal(second.lastRoll, 1);
  assert.equal(second.rolls, 2);
  assert.deepEqual(second.marked, first.marked);
});

test('rolling an absent number updates the result without marking a square', () => {
  const game = { ...newGame(), card: Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1) };
  const next = roll(game, () => .999999);
  assert.equal(next.lastRoll, 20);
  assert.equal(next.won, false);
  assert.equal(next.card.filter((_, i) => isMarked(next, i)).length, 1);
});

for (const [index, line] of LINES.entries()) {
  test(`winning line ${index + 1} is detected and freezes immediately`, () => {
    let game = fixture();
    const numbers = [...new Set(line.map(i => game.card[i]).filter(n => n !== null))];
    for (const number of numbers.slice(0, -1)) game = toggleNumber(game, number);
    assert.equal(game.won, false);
    game = toggleNumber(game, numbers.at(-1)!);
    assert.equal(game.won, true);
    assert.ok(game.winningLines.some(candidate => candidate.join() === line.join()));
    assert.equal(toggleNumber(game, numbers[0]), game);
  });
}

test('scattered marks do not win', () => {
  let game = fixture();
  for (const number of [1, 7, 14]) game = toggleNumber(game, number);
  assert.equal(game.won, false);
});

test('a roll can complete a line, and later rolls never change the locked card', () => {
  let game = fixture();
  for (const n of [1, 2, 3, 4]) game = toggleNumber(game, n);
  const winner = roll(game, () => .225); // 5 completes top row
  assert.equal(winner.won, true);
  let next = winner;
  for (const value of [.975, 0, .525]) next = roll(next, () => value);
  assert.equal(next.lastRoll, 11);
  assert.equal(next.rolls, winner.rolls + 3);
  assert.equal(next.card, winner.card);
  assert.equal(next.marked, winner.marked);
  assert.equal(next.winningLines, winner.winningLines);
  assert.equal(next.won, true);
});

test('New Card replaces the board, clears roll and mark state, and unlocks', () => {
  let winner = fixture();
  for (const n of [1, 2, 3, 4, 5]) winner = toggleNumber(winner, n);
  assert.equal(winner.won, true);
  const fresh = newGame(() => .975);
  assert.notDeepEqual(fresh.card, winner.card);
  assert.equal(fresh.marked.size, 0);
  assert.equal(fresh.won, false);
  assert.equal(fresh.lastRoll, null);
  assert.equal(fresh.rolls, 0);
  assert.deepEqual(fresh.winningLines, []);
  assert.equal(isMarked(fresh, 12), true);
});
