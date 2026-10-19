import { expired, nextExpiry } from '../functions/src/shared/lifetime';
import { completedPatterns, isPattern } from '../functions/src/shared/patterns';
import { isMarked, newGame, roll, toggleNumber, type Game } from './game';
import { PRIZES, type Prize } from './prizes';

export interface Award {
  readonly id: string;
  readonly prize: Prize;
  readonly used: boolean;
}

export interface Session {
  readonly expiresAt: number;
  readonly cardId: string;
  readonly game: Game;
  readonly awards: readonly Award[];
}

export const STORAGE_KEY = 'rpg-games.progress.v1';
// getRandomValues also works on plain HTTP when previewing from a phone on local Wi-Fi.
const newId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), part => part.toString(16).padStart(8, '0')).join('');

export function newSession(random?: () => number, prizeRandom?: () => number, id: () => string = newId): Session {
  return { cardId: id(), game: newGame(random, prizeRandom), awards: [], expiresAt: nextExpiry() };
}

function updateGame(session: Session, game: Game): Session {
  const earned = game.won && !session.awards.some(award => award.id === session.cardId);
  return {
    ...session, game, expiresAt: game === session.game ? session.expiresAt : nextExpiry(),
    awards: earned ? [...session.awards, { id: session.cardId, prize: game.prize, used: false }] : session.awards,
  };
}

export function playNumber(session: Session, number: number): Session {
  if (expired(session.expiresAt)) return newSession();
  return updateGame(session, toggleNumber(session.game, number));
}

export function rollSession(session: Session, random?: () => number): Session {
  if (expired(session.expiresAt)) return newSession();
  return updateGame(session, roll(session.game, random));
}

export function nextCard(session: Session, random?: () => number, prizeRandom?: () => number, id: () => string = newId): Session {
  return { ...session, cardId: id(), game: newGame(random, prizeRandom), expiresAt: nextExpiry(), awards: expired(session.expiresAt) ? [] : session.awards };
}

export function toggleAward(session: Session, id: string): Session {
  if (expired(session.expiresAt)) return newSession();
  if (!session.awards.some(award => award.id === id)) return session;
  return { ...session, expiresAt: nextExpiry(), awards: session.awards.map(award => award.id === id ? { ...award, used: !award.used } : award) };
}

export function serializeSession(session: Session): string {
  return JSON.stringify({
    version: 1, cardId: session.cardId, expiresAt: session.expiresAt,
    game: {
      card: session.game.card, pattern: session.game.pattern, marked: [...session.game.marked], prize: session.game.prize.name,
      won: session.game.won, lastRoll: session.game.lastRoll, rolls: session.game.rolls,
    },
    awards: session.awards.map(award => ({ id: award.id, prize: award.prize.name, used: award.used })),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const number = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 20;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
const findPrize = (value: unknown) => PRIZES.find(prize => prize.name === value);

// Rebuild derived winning lines and canonical prizes rather than trusting saved objects.
export function restoreSession(raw: string): Session | null {
  try {
    const saved: unknown = JSON.parse(raw);
    if (!record(saved) || saved.version !== 1 || !identifier(saved.cardId) || !record(saved.game) || !Array.isArray(saved.awards)) return null;
    const expiresAt = saved.expiresAt === undefined ? nextExpiry() : saved.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expired(expiresAt)) return null;
    const data = saved.game;
    const prize = findPrize(data.prize);
    if (data.pattern !== undefined && !isPattern(data.pattern)) return null;
    if (!prize || !Array.isArray(data.card) || data.card.length !== 25 || !data.card.every((n, i) => i === 12 ? n === null : number(n))) return null;
    if (!Array.isArray(data.marked) || !data.marked.every(number) || new Set(data.marked).size !== data.marked.length) return null;
    if (typeof data.won !== 'boolean' || !Number.isSafeInteger(data.rolls) || (data.rolls as number) < 0) return null;
    if (data.rolls === 0 ? data.lastRoll !== null : !number(data.lastRoll)) return null;
    const game: Game = {
      card: data.card, ...(data.pattern === undefined ? {} : { pattern: data.pattern as string }), marked: new Set(data.marked), prize, won: data.won,
      lastRoll: data.lastRoll as number | null, rolls: data.rolls as number, winningLines: [],
    };
    const winningLines = completedPatterns(game.pattern, index => isMarked(game, index));
    if (game.won !== (winningLines.length > 0)) return null;
    const awards: Award[] = [];
    const ids = new Set<string>();
    for (const item of saved.awards) {
      if (!record(item) || !identifier(item.id) || ids.has(item.id) || typeof item.used !== 'boolean') return null;
      const awardPrize = findPrize(item.prize);
      if (!awardPrize) return null;
      ids.add(item.id);
      awards.push({ id: item.id, prize: awardPrize, used: item.used });
    }
    const currentAward = awards.find(award => award.id === saved.cardId);
    if (game.won ? currentAward?.prize !== prize : currentAward !== undefined) return null;
    return { cardId: saved.cardId, expiresAt, game: { ...game, winningLines }, awards };
  } catch {
    return null;
  }
}

export function loadSession(storage: Pick<Storage, 'getItem'> | undefined, fallback: () => Session = newSession): Session {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return (raw ? restoreSession(raw) : null) ?? fallback();
  } catch {
    return fallback();
  }
}

export function saveSession(session: Session, storage: Pick<Storage, 'setItem'> | undefined): boolean {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, serializeSession(session));
    return true;
  } catch {
    return false;
  }
}
