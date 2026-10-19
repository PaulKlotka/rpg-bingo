import { completedPatterns, selectPattern } from './patterns';
export { LINES } from './patterns';
import { selectPrize, type Prize } from './prizes';

export type Card = readonly (number | null)[];
export interface Game {
  readonly card: Card;
  readonly pattern?: string;
  readonly prize: Prize;
  readonly marked: ReadonlySet<number>;
  readonly won: boolean;
  readonly lastRoll: number | null;
  readonly rolls: number;
  readonly winningLines: readonly (readonly number[])[];
}

export function rollD20(random: () => number = Math.random): number {
  return Math.floor(random() * 20) + 1;
}

export function newGame(random: () => number = Math.random, prizeRandom: () => number = Math.random, patternRandom: () => number = Math.random): Game {
  const shuffle = (values: number[]) => {
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  };
  const numbers = Array.from({ length: 20 }, (_, i) => i + 1);
  const duplicates = shuffle([...numbers]).slice(0, 4);
  const card: (number | null)[] = shuffle([...numbers, ...duplicates]);
  card.splice(12, 0, null);
  return {
    card, pattern: selectPattern(patternRandom),
    prize: selectPrize(prizeRandom),
    marked: new Set(), won: false, lastRoll: null, rolls: 0, winningLines: [],
  };
}

export function isMarked(game: Game, index: number): boolean {
  const number = game.card[index];
  return number === null || game.marked.has(number);
}

function applyMarks(game: Game, marked: ReadonlySet<number>): Game {
  const next = { ...game, marked };
  const winningLines = completedPatterns(game.pattern, index => isMarked(next, index));
  return { ...next, winningLines, won: winningLines.length > 0 };
}

export function toggleNumber(game: Game, number: number): Game {
  if (game.won || !game.card.includes(number)) return game;
  const marked = new Set(game.marked);
  if (marked.has(number)) marked.delete(number);
  else marked.add(number);
  return applyMarks(game, marked);
}

export function roll(game: Game, random: () => number = Math.random): Game {
  const lastRoll = rollD20(random);
  const next = { ...game, lastRoll, rolls: game.rolls + 1 };
  if (game.won) return next;
  return applyMarks(next, new Set([...game.marked, lastRoll]));
}
