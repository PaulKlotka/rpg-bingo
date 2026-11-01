export const IDLE_MS = 24 * 60 * 60 * 1000;
export const GRANT_MS = 60 * 1000;
export interface RewardDefinition { id: string; name: string; qualifyingRoll: string }
export interface Session {
  id: string; name: string; kind: 'solo' | 'shared'; joinCode: string;
  creatorId: string; memberIds: string[]; createdAt: number; expiresAt: number;
}
export interface Member { playerId: string; displayName: string; joinedAt: number }
export interface Offer {
  id: string; gameId: string; sessionId: string; reward: RewardDefinition; createdAt: number;
}
export interface Award {
  id: string; offerId: string; gameId: string; playerId: string; playerName: string;
  reward: RewardDefinition; awardedAt: number; consumedAt: number | null;
}
export interface SessionView {
  session: Session; members: Member[]; inventory: Award[]; history: Award[];
}
export const isExpired = (session: Pick<Session, 'expiresAt'>, now: number): boolean => session.expiresAt <= now;
