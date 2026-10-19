export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const nextExpiry = (now = Date.now()): number => now + SESSION_IDLE_MS;
export const expired = (expiresAt: number | undefined, now = Date.now()): boolean => expiresAt !== undefined && expiresAt <= now;
