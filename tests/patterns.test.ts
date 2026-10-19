import assert from 'node:assert/strict';
import test from 'node:test';
import { CHARACTERS, completedPatterns, getPattern, isPattern, LINES, PATTERNS, selectPattern, SHAPES } from '../functions/src/shared/patterns';
import { isMarked, newGame, toggleNumber } from '../src/game';
import { newSession, restoreSession, serializeSession } from '../src/session';

test('approved masks include fifteen shapes, all letters and digits, and the corrected windmill', () => {
  assert.equal(SHAPES.length, 15); assert.equal(CHARACTERS.length, 36);
  assert.equal(new Set(PATTERNS.map(p => p.id)).size, 53);
  for (const p of PATTERNS) {
    assert.ok(p.squares.length > 0);
    assert.equal(new Set(p.squares).size, p.squares.length);
    assert.ok(p.squares.every(i => Number.isInteger(i) && i >= 0 && i < 25));
  }
  assert.deepEqual(getPattern('windmill').squares, [0,1,3,4,5,6,8,9,15,16,18,19,20,21,23,24]);
});

test('all eighteen categories and all characters can be drawn, with independent pattern randomness', () => {
  const selected = new Set<string>();
  for (let category = 0; category < 18; category++) {
    const p = selectPattern(() => (category + .5) / 18);
    assert.ok(isPattern(p)); selected.add(p);
  }
  assert.equal(selected.size, 18);
  for (let character = 0; character < 36; character++) {
    let first = true;
    const p = selectPattern(() => { if (first) { first = false; return 2.5 / 18; } return (character + .5) / 36; });
    assert.equal(p, CHARACTERS[character].id);
  }
  const a = newGame(() => 0, () => 0, () => 0);
  const b = newGame(() => 0, () => 0, () => .999999);
  assert.deepEqual(a.card, b.card); assert.equal(a.prize, b.prize); assert.notEqual(a.pattern, b.pattern);
});

test('single line accepts all twelve lines and two lines accepts all sixty-six pairs', () => {
  for (const line of LINES) {
    const marked = new Set([...line, 12]);
    assert.ok(completedPatterns('single-line', i => marked.has(i)).length);
    assert.equal(completedPatterns('two-lines', i => marked.has(i)).length, 0);
  }
  for (let a = 0; a < 12; a++) for (let b = a + 1; b < 12; b++) {
    const marked = new Set([...LINES[a], ...LINES[b], 12]);
    assert.ok(completedPatterns('two-lines', i => marked.has(i)).length >= 2);
  }
});

for (const pattern of [...SHAPES, ...CHARACTERS]) {
  test(`${pattern.name} requires every target and permits extra marks`, () => {
    const target = new Set([...pattern.squares, 12]);
    assert.equal(completedPatterns(pattern.id, i => target.has(i)).length, 1);
    for (const missing of pattern.squares.filter(i => i !== 12)) {
      assert.equal(completedPatterns(pattern.id, i => i !== missing && target.has(i)).length, 0);
    }
    assert.equal(completedPatterns(pattern.id, () => true).length, 1);
  });
}

test('game play wins only its selected pattern, groups duplicate numbers, then locks', () => {
  for (const pattern of [...SHAPES, ...CHARACTERS]) {
    let game = { ...newGame(() => .5), pattern: pattern.id };
    for (const number of new Set(pattern.squares.map(i => game.card[i]).filter(n => n !== null))) {
      if (!game.marked.has(number)) game = toggleNumber(game, number) as typeof game;
      assert.equal(game.won, pattern.squares.every(i => isMarked(game, i)));
    }
    assert.equal(game.won, true);
    assert.equal(toggleNumber(game, game.card[0]!), game);
  }
});

test('pattern survives reload; unknown patterns are rejected and legacy line games still restore', () => {
  const session = newSession();
  const withPattern = { ...session, game: { ...session.game, pattern: 'windmill' } };
  assert.deepEqual(restoreSession(serializeSession(withPattern)), withPattern);
  const saved = JSON.parse(serializeSession(withPattern));
  saved.game.pattern = 'invented'; assert.equal(restoreSession(JSON.stringify(saved)), null);
  delete saved.game.pattern;
  const legacy = restoreSession(JSON.stringify(saved));
  assert.ok(legacy); assert.equal(getPattern(legacy.game.pattern).id, 'single-line');
});
