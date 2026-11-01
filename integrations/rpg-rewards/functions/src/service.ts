import { createHash, randomBytes } from 'node:crypto';
import { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { selectReward } from '../../shared/catalog';
import { Award, GRANT_MS, IDLE_MS, Member, Offer, Session, SessionView, isExpired } from '../../shared/model';

type Input = Record<string, unknown>;
export interface GameClient { serviceAccount: string; redirectUris: string[] }
export type GameClients = Record<string, GameClient>;
export const fail = (code: 'invalid-argument' | 'permission-denied' | 'not-found' | 'failed-precondition' | 'already-exists' | 'unauthenticated', message: string): never => { throw new HttpsError(code, message); };
export function textField(value: unknown, name: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) return fail('invalid-argument', `Invalid ${name}.`);
  return value.trim();
}
function id(value: unknown, name: string): string {
  const result = textField(value, name);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) return fail('invalid-argument', `Invalid ${name}.`);
  return result;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (v: unknown): string => JSON.stringify(v, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const token = () => randomBytes(24).toString('base64url');

export class RewardsService {
  constructor(readonly db: Firestore, readonly clients: GameClients, readonly clock = Date.now, readonly random = Math.random) {}

  private async session(tx: Transaction, sessionId: string): Promise<Session> {
    const snap = await tx.get(this.db.doc(`sessions/${sessionId}`));
    if (!snap.exists) return fail('not-found', 'Session not found.');
    const session = snap.data() as Session;
    if (isExpired(session, this.clock())) return fail('failed-precondition', 'This session has expired.');
    return session;
  }
  private member(session: Session, playerId: string) {
    if (!session.memberIds.includes(playerId)) fail('permission-denied', 'Player is not a member of this session.');
  }
  private touch(tx: Transaction, session: Session) {
    tx.update(this.db.doc(`sessions/${session.id}`), { expiresAt: this.clock() + IDLE_MS });
  }
  private async once<T>(tx: Transaction, path: string, input: Input, work: () => Promise<T>): Promise<T> {
    const ref = this.db.doc(path);
    const previous = await tx.get(ref);
    const fingerprint = hash(canonical(input));
    if (previous.exists) {
      if (previous.get('fingerprint') !== fingerprint) return fail('already-exists', 'Request ID was already used for different input.');
      return previous.get('result') as T;
    }
    const result = await work();
    tx.create(ref, { fingerprint, result, createdAt: this.clock(), deleteAfter: new Date(this.clock() + 7 * IDLE_MS) });
    return result;
  }

  async player(playerId: string | undefined, raw: unknown): Promise<unknown> {
    if (!playerId) return fail('unauthenticated', 'A guest identity is required.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid-argument', 'Expected a command object.');
    const input = raw as Input;
    const action = textField(input.action, 'action');
    if (action === 'list') {
      const sessions = await this.db.collection('sessions').where('memberIds', 'array-contains', playerId).get();
      return sessions.docs.map(doc => doc.data() as Session).sort((a, b) => b.createdAt - a.createdAt);
    }
    if (action === 'view') return this.view(playerId, id(input.sessionId, 'session ID'));
    if (action === 'create') {
      const requestId = id(input.requestId, 'request ID');
      const name = textField(input.name, 'session name', 70);
      const displayName = textField(input.displayName, 'player name', 40);
      if (input.kind !== 'solo' && input.kind !== 'shared') return fail('invalid-argument', 'Choose solo or shared.');
      const sessionId = this.db.collection('sessions').doc().id;
      const joinCode = randomBytes(6).toString('hex').toUpperCase();
      return this.db.runTransaction(tx => this.once(tx, `playerCommands/${hash(`${playerId}:${requestId}`)}`, input, async () => {
        const codeRef = this.db.doc(`joinCodes/${joinCode}`);
        if ((await tx.get(codeRef)).exists) return fail('already-exists', 'Please retry creating the session.');
        const now = this.clock();
        const session: Session = { id: sessionId, name, kind: input.kind as 'solo' | 'shared', joinCode, creatorId: playerId, memberIds: [playerId], createdAt: now, expiresAt: now + IDLE_MS };
        tx.create(this.db.doc(`sessions/${sessionId}`), session);
        tx.create(this.db.doc(`sessions/${sessionId}/members/${playerId}`), { playerId, displayName, joinedAt: now });
        tx.create(codeRef, { sessionId });
        return { sessionId };
      }));
    }
    if (action === 'join') {
      const joinCode = textField(input.joinCode, 'join code', 12).toUpperCase();
      if (!/^[A-F0-9]{12}$/.test(joinCode)) return fail('invalid-argument', 'Enter the 12-character join code.');
      const displayName = textField(input.displayName, 'player name', 40);
      return this.db.runTransaction(async tx => {
        const code = await tx.get(this.db.doc(`joinCodes/${joinCode}`));
        if (!code.exists) return fail('not-found', 'Join code not found.');
        const session = await this.session(tx, code.get('sessionId'));
        if (session.kind !== 'shared') return fail('permission-denied', 'Solo sessions cannot be joined.');
        if (!session.memberIds.includes(playerId)) {
          tx.create(this.db.doc(`sessions/${session.id}/members/${playerId}`), { playerId, displayName, joinedAt: this.clock() });
          tx.update(this.db.doc(`sessions/${session.id}`), { memberIds: [...session.memberIds, playerId], expiresAt: this.clock() + IDLE_MS });
        }
        return { sessionId: session.id };
      });
    }
    if (action === 'consume') {
      const sessionId = id(input.sessionId, 'session ID');
      const awardId = id(input.awardId, 'award ID');
      const requestId = id(input.requestId, 'request ID');
      if (typeof input.consumed !== 'boolean') return fail('invalid-argument', 'Expected a consumption state.');
      return this.db.runTransaction(async tx => {
        const session = await this.session(tx, sessionId);
        this.member(session, playerId);
        return this.once(tx, `sessions/${sessionId}/receipts/${hash(`player:${playerId}:${requestId}`)}`, input, async () => {
          const ref = this.db.doc(`sessions/${sessionId}/awards/${awardId}`);
          const snap = await tx.get(ref);
          if (!snap.exists) return fail('not-found', 'Reward not found.');
          const award = snap.data() as Award;
          if (award.playerId !== playerId) return fail('permission-denied', 'Only the owner can change this reward.');
          if ((award.consumedAt !== null) !== input.consumed) {
            tx.update(ref, { consumedAt: input.consumed ? this.clock() : null });
            this.touch(tx, session);
          }
          return { awardId, consumed: input.consumed };
        });
      });
    }
    if (action === 'connect') {
      const gameId = id(input.gameId, 'game ID');
      const redirectUri = textField(input.redirectUri, 'redirect URI', 2048);
      const state = textField(input.state, 'state', 256);
      if (!this.clients[gameId]?.redirectUris.includes(redirectUri)) return fail('permission-denied', 'Game callback is not registered.');
      const sessionId = id(input.sessionId, 'session ID');
      const code = token();
      return this.db.runTransaction(async tx => {
        const session = await this.session(tx, sessionId);
        this.member(session, playerId);
        tx.create(this.db.doc(`grants/${hash(code)}`), {
          playerId, sessionId, gameId, redirectUri, expiresAt: this.clock() + GRANT_MS,
          deleteAfter: new Date(this.clock() + GRANT_MS),
        });
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        return { callbackUrl: callback.toString() };
      });
    }
    return fail('invalid-argument', 'Unknown player command.');
  }

  async view(playerId: string, sessionId: string): Promise<SessionView> {
    // One consistent transaction prevents a view from mixing membership or expiry snapshots.
    return this.db.runTransaction(async tx => {
      const session = await this.session(tx, sessionId);
      this.member(session, playerId);
      const members = await tx.get(this.db.collection(`sessions/${sessionId}/members`));
      const awards = await tx.get(this.db.collection(`sessions/${sessionId}/awards`));
      const history = awards.docs.map(doc => doc.data() as Award).sort((a, b) => b.awardedAt - a.awardedAt || a.id.localeCompare(b.id));
      return { session, members: members.docs.map(doc => doc.data() as Member), inventory: history.filter(a => a.playerId === playerId), history };
    });
  }

  async game(gameId: string, raw: unknown): Promise<unknown> {
    if (!this.clients[gameId]) return fail('permission-denied', 'Game is not registered.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid-argument', 'Expected a command object.');
    const input = raw as Input;
    const action = textField(input.action, 'action');
    if (action === 'exchange') {
      const code = textField(input.code, 'code', 128);
      const redirectUri = textField(input.redirectUri, 'redirect URI', 2048);
      return this.db.runTransaction(async tx => {
        const ref = this.db.doc(`grants/${hash(code)}`);
        const grant = await tx.get(ref);
        if (!grant.exists || grant.get('expiresAt') <= this.clock()) return fail('permission-denied', 'Connection code is invalid or expired.');
        if (grant.get('gameId') !== gameId || grant.get('redirectUri') !== redirectUri) return fail('permission-denied', 'Connection code belongs to another game or callback.');
        const session = await this.session(tx, grant.get('sessionId'));
        this.member(session, grant.get('playerId'));
        const member = await tx.get(this.db.doc(`sessions/${session.id}/members/${grant.get('playerId')}`));
        tx.delete(ref);
        return { playerId: grant.get('playerId'), sessionId: session.id, displayName: member.get('displayName') };
      });
    }
    const sessionId = id(input.sessionId, 'session ID');
    const playerId = id(input.playerId, 'player ID');
    if (action === 'session') return this.view(playerId, sessionId);
    const requestId = id(input.requestId, 'request ID');
    if (!['draw', 'award', 'activity'].includes(action)) return fail('invalid-argument', 'Unknown game command.');
    const offerId = action === 'award' ? id(input.offerId, 'offer ID') : token();
    return this.db.runTransaction(async tx => {
      const session = await this.session(tx, sessionId);
      this.member(session, playerId);
      return this.once(tx, `sessions/${sessionId}/receipts/${hash(`game:${gameId}:${requestId}`)}`, input, async () => {
        if (action === 'draw') {
          const offer: Offer = { id: offerId, gameId, sessionId, reward: selectReward(this.random), createdAt: this.clock() };
          tx.create(this.db.doc(`sessions/${sessionId}/offers/${offerId}`), offer);
          this.touch(tx, session);
          return offer;
        }
        if (action === 'activity') {
          this.touch(tx, session);
          return { accepted: true };
        }
        const offer = await tx.get(this.db.doc(`sessions/${sessionId}/offers/${offerId}`));
        if (!offer.exists) return fail('not-found', 'Offer not found.');
        if (offer.get('gameId') !== gameId) return fail('permission-denied', 'Offer belongs to another game.');
        // One award per offer and winner; tied winners can receive the same offer.
        const awardId = hash(`${offerId}:${playerId}`);
        const ref = this.db.doc(`sessions/${sessionId}/awards/${awardId}`);
        const previous = await tx.get(ref);
        if (previous.exists) return previous.data() as Award;
        const member = await tx.get(this.db.doc(`sessions/${sessionId}/members/${playerId}`));
        const award: Award = { id: awardId, offerId, gameId, playerId, playerName: member.get('displayName'), reward: offer.get('reward'), awardedAt: this.clock(), consumedAt: null };
        tx.create(ref, award);
        this.touch(tx, session);
        return award;
      });
    });
  }

  async cleanup(): Promise<number> {
    const expired = await this.db.collection('sessions').where('expiresAt', '<=', this.clock()).limit(50).get();
    let removed = 0;
    for (const snapshot of expired.docs) {
      const claimed = await this.db.runTransaction(async tx => {
        const fresh = await tx.get(snapshot.ref);
        if (!fresh.exists || fresh.get('expiresAt') > this.clock()) return false;
        // Keep the parent as a retry marker until recursive deletion succeeds.
        tx.update(snapshot.ref, { cleaning: true });
        tx.delete(this.db.doc(`joinCodes/${fresh.get('joinCode')}`));
        return true;
      });
      if (claimed) { await this.db.recursiveDelete(snapshot.ref); removed++; }
    }
    for (const collection of ['grants', 'playerCommands']) {
      const stale = await this.db.collection(collection).where('deleteAfter', '<=', new Date(this.clock())).limit(250).get();
      const batch = this.db.batch();
      stale.docs.forEach(doc => batch.delete(doc.ref));
      if (!stale.empty) await batch.commit();
    }
    return removed;
  }
}
