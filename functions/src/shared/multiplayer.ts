export interface RosterMember { uid: string; name: string; eligibleRound: number }
export interface RoundResult {
  round: number;
  number: number;
  prize: string;
  pattern?: string;
  winners: { uid: string; name: string }[];
}
export interface Room {
  undo?: {
    uid: string; requestId: string; round: number; number: number;
    marks: number[]; rolls: number; lastSubmitter: string | null;
    lastAction: Room['lastAction'];
  } | null;
  lastUndo?: { name: string; number: number; round: number } | null;
  expiresAt?: number;
  closed?: boolean;
  phase: 'inviting' | 'shared';
  creator: string;
  round: number;
  revision: number;
  rolls: number;
  marks: number[];
  prize: string;
  pattern?: string;
  members: RosterMember[];
  lastSubmitter: string | null;
  lastAction: { number: number; name: string; round: number } | null;
  lastResult: RoundResult | null;
}
export interface Player {
  left?: boolean;
  name: string;
  eligibleRound: number;
  card: (number | null)[] | null;
}
export interface MultiplayerAward {
  id: string;
  round: number;
  prize: string;
  used: boolean;
}
export interface RollReceipt { number: number; playedRound: number; resultingRound: number; revision: number }
