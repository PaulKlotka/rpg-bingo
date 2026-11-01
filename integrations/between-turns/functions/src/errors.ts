export type ErrorCode = 'invalid-argument' | 'unauthenticated' | 'permission-denied' | 'not-found' | 'already-exists' | 'failed-precondition' | 'resource-exhausted';
export class DomainError extends Error { constructor(public code: ErrorCode, message: string) { super(message); } }
export function assert(condition: unknown, code: ErrorCode, message: string): asserts condition { if (!condition) throw new DomainError(code, message); }
