import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { selectReward } from '../../shared/catalog';
import type { Award, Offer } from '../../shared/model';
import type { HubContext, HubGateway } from './hub-gateway';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function check(condition: unknown, message: string, code: 'invalid-argument' | 'failed-precondition' | 'permission-denied' | 'already-exists' = 'failed-precondition'): asserts condition { if (!condition) throw new HttpsError(code, message); }
function id(value: unknown): string { check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'Invalid identifier.', 'invalid-argument'); return value; }
interface CentralOffer extends Offer { runId: string }
interface Connection { nonce: string; expiresAt: number; context: HubContext | null; connecting: boolean }
export class CentralRewards {
  constructor(private db: Firestore, private hub: HubGateway, private now = Date.now) {}
  private session(sessionId: string) { return this.db.doc(`centralSessions/${sessionId}`); }
  private async replay(path: string, input: object) {
    const receipt = await this.db.doc(path).get();
    if (!receipt.exists) return null;
    check(receipt.get('fingerprint') === hash(canonical(input)), 'Request ID reused with different input.', 'already-exists');
    return receipt.get('result');
  }
  private async once<T>(tx: Transaction, path: string, input: object, work: () => Promise<T>) {
    const ref = this.db.doc(path); const receipt = await tx.get(ref);
    const fingerprint = hash(canonical(input));
    if (receipt.exists) { check(receipt.get('fingerprint') === fingerprint, 'Request ID reused with different input.', 'already-exists'); return receipt.get('result') as T; }
    const result = await work(); tx.create(ref, { fingerprint, result }); return result;
  }
  private activity(tx: Transaction, sessionId: string, playerId: string, eventId: string) {
    tx.set(this.session(sessionId).collection('activity').doc(eventId), { sessionId, playerId, eventId });
  }
  async flush(sessionId: string) {
    const events = await this.session(sessionId).collection('activity').get();
    for (const event of events.docs) {
      const data = event.data();
      await this.hub.activity(sessionId, data.playerId, data.eventId);
      await event.ref.delete();
    }
  }
  async game(gameId: string, input: Record<string, unknown>) {
    id(gameId); const sessionId = id(input.sessionId); const runId = id(input.runId); const requestId = id(input.requestId);
    check(input.action === 'draw' || input.action === 'settle', 'Unsupported central game command.', 'invalid-argument');
    const path = `centralReceipts/${hash(`${gameId}/${sessionId}/${requestId}`)}`;
    const previous = await this.replay(path, input);
    if (previous) { await this.flush(sessionId); return previous; }
    const session = this.session(sessionId);
    if (input.action === 'draw') {
      const playerId = id(input.playerId);
      await this.hub.context(sessionId, playerId, runId, gameId);
      const offerId = hash(`${gameId}/${sessionId}/${runId}`);
      const ref = session.collection('offers').doc(offerId);
      const result = await this.db.runTransaction(tx => this.once(tx, path, input, async () => {
        const stored = await tx.get(ref);
        if (stored.exists) return stored.data() as CentralOffer;
        const offer: CentralOffer = { id: offerId, sessionId, gameId, runId, reward: selectReward(() => randomInt(2 ** 32) / 2 ** 32), createdAt: this.now() };
        tx.create(ref, offer); tx.set(session, { id: sessionId, updatedAt: this.now() }, { merge: true });
        this.activity(tx, sessionId, playerId, hash(`offer/${offerId}`)); return offer;
      }));
      await this.flush(sessionId); return result;
    }
    const offerId = id(input.offerId);
    check(Array.isArray(input.winnerIds) && input.winnerIds.length > 0 && input.winnerIds.length <= 32, 'Invalid winners.', 'invalid-argument');
    const winners = input.winnerIds.map(id);
    check(new Set(winners).size === winners.length, 'Winners must be distinct.', 'invalid-argument');
    const contexts = await Promise.all(winners.map(playerId => this.hub.context(sessionId, playerId, runId, gameId)));
    const settlementId = hash(`${gameId}/${sessionId}/${runId}`);
    const settlementRef = session.collection('settlements').doc(settlementId);
    const result = await this.db.runTransaction(tx => this.once(tx, path, input, async () => {
      const offer = (await tx.get(session.collection('offers').doc(offerId))).data() as CentralOffer | undefined;
      const existing = await tx.get(settlementRef);
      check(offer && offer.gameId === gameId && offer.runId === runId && offer.sessionId === sessionId, 'Offer does not belong to this game.', 'permission-denied');
      const fingerprint = hash(canonical({ offerId, winnerIds: [...winners].sort() }));
      if (existing.exists) { check(existing.get('fingerprint') === fingerprint, 'This run already has a different result.', 'already-exists'); return { receipt: existing.get('receipt') as string }; }
      const awards = contexts.map(c => ({ id: hash(`${offerId}/${c.playerId}`), offerId, gameId, playerId: c.playerId, playerName: c.displayName, reward: offer.reward, awardedAt: this.now(), consumedAt: null } satisfies Award));
      for (const award of awards) tx.create(session.collection('awards').doc(award.id), award);
      tx.create(settlementRef, { fingerprint, receipt: settlementId });
      tx.set(session, { id: sessionId, updatedAt: this.now() }, { merge: true });
      this.activity(tx, sessionId, winners[0], hash(`settle/${settlementId}`));
      return { receipt: settlementId };
    }));
    await this.flush(sessionId); return result;
  }
  async begin(nonce: unknown) {
    id(nonce); const credential = randomBytes(32).toString('base64url');
    await this.db.doc(`centralConnections/${hash(credential)}`).create({ nonce, expiresAt: this.now() + 60000, context: null, connecting: false });
    return { credential };
  }
  async connect(credential: string, nonce: unknown, grant: unknown) {
    id(nonce); check(typeof grant === 'string' && grant.length > 0 && grant.length <= 1024, 'Invalid grant.');
    const ref = this.db.doc(`centralConnections/${hash(credential)}`);
    await this.db.runTransaction(async tx => {
      const connection = (await tx.get(ref)).data() as Connection | undefined;
      check(connection && connection.nonce === nonce && connection.expiresAt > this.now() && !connection.connecting && !connection.context, 'Reload to reconnect.');
      tx.update(ref, { connecting: true });
    });
    const c = await this.hub.exchange(grant, id(nonce));
    check(c.version === 1 && c.runId === null && c.expiresAt > this.now(), 'Invalid hub context.'); id(c.sessionId); id(c.playerId);
    await ref.update({ context: c, connecting: false, expiresAt: this.now() + 3600000 });
    return this.player(credential, { action: 'view' });
  }
  async player(credential: string, input: Record<string, unknown>) {
    check(/^[A-Za-z0-9_-]{43}$/.test(credential), 'Connect through Between Turns.', 'permission-denied');
    const stored = (await this.db.doc(`centralConnections/${hash(credential)}`).get()).data() as Connection | undefined;
    check(stored?.context && stored.expiresAt > this.now(), 'Reload to reconnect through Between Turns.');
    const c = await this.hub.context(stored.context.sessionId, stored.context.playerId);
    check(input.action === 'view' || input.action === 'consume', 'Unsupported reward command.', 'invalid-argument');
    if (input.action === 'consume') {
      const awardId = id(input.awardId); const requestId = id(input.requestId);
      check(typeof input.consumed === 'boolean', 'Invalid consumption state.', 'invalid-argument');
      const eventId = hash(`${c.sessionId}/${c.playerId}/${requestId}`);
      const ref = this.session(c.sessionId).collection('awards').doc(awardId);
      await this.db.runTransaction(tx => this.once(tx, `centralPlayerReceipts/${eventId}`, { playerId: c.playerId, ...input }, async () => {
        const award = (await tx.get(ref)).data() as Award | undefined;
        check(award && award.playerId === c.playerId, 'This reward belongs to another player.', 'permission-denied');
        if ((award.consumedAt !== null) !== input.consumed) {
          tx.update(ref, { consumedAt: input.consumed ? this.now() : null });
          this.activity(tx, c.sessionId, c.playerId, eventId);
        }
        return { accepted: true };
      }));
      await this.flush(c.sessionId);
    }
    const awards = (await this.session(c.sessionId).collection('awards').get()).docs.map(doc => doc.data() as Award).sort((a, b) => b.awardedAt - a.awardedAt || a.id.localeCompare(b.id));
    return { playerId: c.playerId, displayName: c.displayName, sessionId: c.sessionId, expiresAt: c.expiresAt, inventory: awards.filter(a => a.playerId === c.playerId), history: awards };
  }
  async maintain() {
    const activity = await this.db.collectionGroup('activity').limit(100).get();
    for (const event of activity.docs) {
      if (!event.ref.path.startsWith('centralSessions/')) continue;
      try { const data = event.data(); await this.hub.activity(data.sessionId, data.playerId, data.eventId); await event.ref.delete(); } catch { /* Retain the durable event for retry. */ }
    }
    const old = await this.db.collection('centralConnections').where('expiresAt', '<=', this.now()).limit(300).get();
    if (!old.empty) { const batch = this.db.batch(); old.docs.forEach(doc => batch.delete(doc.ref)); await batch.commit(); }
  }
}
