import { completedPatterns } from './patterns';

export interface CentralContext {
  version: 1; playerId: string; displayName: string; sessionId: string; runId: string; expiresAt: number;
}
export interface RewardOffer { id: string; reward: { id: string; name: string; qualifyingRoll: string } }
export interface EmbeddedRun {
  sessionId: string; runId: string; phase: 'playing' | 'review' | 'settling' | 'complete';
  pattern: string; offer: RewardOffer | null; offerPlayerId: string; revision: number; marks: number[]; rolls: number;
  players: Record<string, { name: string; card: (number | null)[] }>;
  last: { number: number; playerId: string } | null;
  undo: { playerId: string; marks: number[]; rolls: number; last: EmbeddedRun['last']; eventId: string } | null;
  pending: { winnerIds: string[]; confirmAt: number } | null;
  settlement: { winnerIds: string[]; eventId: string; receipt: string | null } | null;
}
export type Move = { action: 'roll'; number: number } | { action: 'undo' };
export function applyMove(run: EmbeddedRun, playerId: string, move: Move, eventId: string, activeIds: string[], now: number): EmbeddedRun {
  if (!run.players[playerId] || !activeIds.includes(playerId)) throw new Error('You are no longer in this game.');
  if (!run.offer || !['playing', 'review'].includes(run.phase)) throw new Error('This game is awaiting completion.');
  if (move.action === 'undo') {
    if (!run.undo || run.undo.playerId !== playerId || (run.pending && now >= run.pending.confirmAt)) throw new Error('Only your latest roll can be undone before review ends.');
    return { ...run, marks: run.undo.marks, rolls: run.undo.rolls, last: run.undo.last, undo: null, pending: null, phase: 'playing', revision: run.revision + 1 };
  }
  if (run.phase !== 'playing') throw new Error('Cards are locked during the fifteen-second bingo review.');
  if (!Number.isInteger(move.number) || move.number < 1 || move.number > 20) throw new Error('Choose a number from 1 to 20.');
  if (activeIds.length > 1 && run.last?.playerId === playerId) throw new Error('Another player must submit the next roll.');
  const marks = [...new Set([...run.marks, move.number])];
  const winnerIds = activeIds.filter(id => {
    const player = run.players[id];
    return player && completedPatterns(run.pattern, i => player.card[i] === null || marks.includes(player.card[i]!)).length > 0;
  });
  return { ...run, marks, rolls: run.rolls + 1, revision: run.revision + 1,
    last: { number: move.number, playerId },
    undo: { playerId, marks: run.marks, rolls: run.rolls, last: run.last, eventId },
    phase: winnerIds.length ? 'review' : 'playing', pending: winnerIds.length ? { winnerIds, confirmAt: now + 15_000 } : null };
}
export function confirmRun(run: EmbeddedRun, now: number): EmbeddedRun {
  if (run.phase !== 'review' || !run.pending || now < run.pending.confirmAt) return run;
  return { ...run, phase: 'settling', undo: null, revision: run.revision + 1,
    settlement: { winnerIds: run.pending.winnerIds, eventId: run.runId, receipt: null } };
}
