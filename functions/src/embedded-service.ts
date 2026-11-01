import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { generateCard } from './shared/game';
import { selectPattern } from './shared/patterns';
import { applyMove, confirmRun, type CentralContext, type EmbeddedRun } from './shared/embedded';
import type { IntegrationGateway } from './integration-gateway';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomInt(2 ** 32) / 2 ** 32;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HttpsError('failed-precondition', message);
}
type BrowserConnection = { nonce: string; expiresAt: number; context: CentralContext | null; connecting: boolean };
export class EmbeddedService {
  constructor(private db: Firestore, private gateway: IntegrationGateway, private now = Date.now) {}
  private runRef(c: CentralContext) { return this.db.doc(`embeddedRuns/${hash(`${c.sessionId}/${c.runId}`)}`); }
  async begin(nonce: unknown) {
    requireValue(id(nonce), 'Invalid frame nonce.');
    const credential = randomBytes(32).toString('base64url');
    await this.db.doc(`embeddedConnections/${hash(credential)}`).create({ nonce, expiresAt: this.now() + 60_000, context: null, connecting: false } satisfies BrowserConnection);
    return { credential };
  }
  async connect(credential: string, nonce: unknown, grant: unknown) {
    requireValue(id(nonce) && typeof grant === 'string' && grant.length > 0 && grant.length <= 1024, 'Invalid connection.');
    const ref = this.db.doc(`embeddedConnections/${hash(credential)}`);
    await this.db.runTransaction(async tx => {
      const connection = (await tx.get(ref)).data() as BrowserConnection | undefined;
      requireValue(connection && connection.nonce === nonce && connection.expiresAt > this.now() && !connection.context && !connection.connecting, 'Start a fresh frame connection.');
      tx.update(ref, { connecting: true });
    });
    // A lost exchange response deliberately requires a new grant and pending connection.
    const context = await this.gateway.exchange(grant, nonce);
    requireValue(context.version === 1 && id(context.sessionId) && id(context.runId) && id(context.playerId) && context.expiresAt > this.now(), 'Invalid central context.');
    await ref.update({ context, connecting: false, expiresAt: Math.min(context.expiresAt, this.now() + 60 * 60_000) });
    return this.command(credential, { action: 'view' });
  }
  private async authorize(credential: string) {
    requireValue(typeof credential === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credential), 'Connect through Between Turns.');
    const connection = (await this.db.doc(`embeddedConnections/${hash(credential)}`).get()).data() as BrowserConnection | undefined;
    requireValue(connection?.context && connection.expiresAt > this.now(), 'Refresh to reconnect through Between Turns.');
    return this.gateway.context(connection.context);
  }
  private async ensureRun(c: CentralContext) {
    const ref = this.runRef(c);
    await this.db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const run = snapshot.data() as EmbeddedRun | undefined;
      if (!run) {
        tx.create(ref, { sessionId: c.sessionId, runId: c.runId, phase: 'playing', pattern: selectPattern(random), offer: null, offerPlayerId: c.playerId, revision: 0, marks: [], rolls: 0,
          players: { [c.playerId]: { name: c.displayName, card: generateCard(random) } }, last: null, undo: null, pending: null, settlement: null,
        } satisfies EmbeddedRun);
      } else if (!run.players[c.playerId] && ['playing', 'review'].includes(run.phase)) {
        requireValue(Object.keys(run.players).length < 32, 'This game is full.');
        tx.update(ref, { players: { ...run.players, [c.playerId]: { name: c.displayName, card: generateCard(random) } }, revision: run.revision + 1 });
      }
    });
    const run = (await ref.get()).data() as EmbeddedRun;
    if (!run.offer) {
      const offer = await this.gateway.draw({ ...c, playerId: run.offerPlayerId });
      requireValue(id(offer.id) && !!offer.reward && typeof offer.reward.name === 'string' && typeof offer.reward.qualifyingRoll === 'string', 'Rewards returned an invalid offer.');
      await this.db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data() as EmbeddedRun;
        if (!current.offer) tx.update(ref, { offer });
      });
    }
  }
  async command(credential: string, input: Record<string, unknown>) {
    const c = await this.authorize(credential);
    requireValue(['view', 'roll', 'undo'].includes(String(input.action)), 'Unknown embedded command.');
    await this.ensureRun(c);
    const ref = this.runRef(c);
    await this.flushActivity(c);
    if (input.action !== 'view') {
      requireValue(id(input.requestId) && Number.isSafeInteger(input.revision), 'Invalid move.');
      requireValue(input.action !== 'roll' || input.kind === 'virtual' || (input.kind === 'physical' && Number.isInteger(input.number) && Number(input.number) >= 1 && Number(input.number) <= 20), 'Invalid roll.');
      const snapshot = (await ref.get()).data() as EmbeddedRun;
      // Departed members cannot win or block another player's turn. Failure to contact
      // the hub is an outage, never evidence that a member departed.
      const members = await Promise.all(Object.keys(snapshot.players).map(async playerId => {
        try { await this.gateway.context({ ...c, playerId }); return playerId; }
        catch (error) {
          if ((error as { response?: { data?: { error?: { code?: string } } } }).response?.data?.error?.code !== 'permission-denied') throw error;
          return null;
        }
      }));
      const activeIds = members.filter((value): value is string => value !== null);
      const requestId = input.requestId;
      const eventId = hash(`${c.runId}/${c.playerId}/${requestId}`);
      const receiptRef = ref.collection('commands').doc(eventId);
      const fingerprint = JSON.stringify([input.action, input.revision, input.kind ?? null, input.number ?? null]);
      const number = input.kind === 'virtual' ? randomInt(1, 21) : Number(input.number);
      await this.db.runTransaction(async tx => {
        const receipt = await tx.get(receiptRef);
        const run = (await tx.get(ref)).data() as EmbeddedRun;
        if (receipt.exists) { requireValue(receipt.get('fingerprint') === fingerprint, 'Request ID was reused for a different move.'); return; }
        requireValue(run.revision === input.revision, 'The game changed. Check the latest card before submitting.');
        let next: EmbeddedRun;
        try { next = applyMove(run, c.playerId, input.action === 'undo' ? { action: 'undo' } : { action: 'roll', number }, eventId, activeIds, this.now()); }
        catch (error) { throw new HttpsError('failed-precondition', (error as Error).message); }
        // Bound accumulated departed cards; the hub permits at most 32 current members.
        next.players = Object.fromEntries(Object.entries(next.players).filter(([key]) => activeIds.includes(key)));
        tx.set(ref, next);
        tx.create(receiptRef, { fingerprint });
        tx.create(ref.collection('activity').doc(eventId), { context: c, eventId, revision: next.revision });
      });
      await this.flushActivity(c);
    }
    await this.progress(c);
    const run = (await ref.get()).data() as EmbeddedRun;
    // Other players' cards and browser credentials never leave the backend.
    return { playerId: c.playerId, card: run.players[c.playerId]?.card ?? null, pattern: run.pattern, offer: run.offer,
      phase: run.phase, revision: run.revision, marks: run.marks, rolls: run.rolls, last: run.last,
      canUndo: run.undo?.playerId === c.playerId && (!run.pending || this.now() < run.pending.confirmAt),
      pending: run.pending, winners: run.settlement?.winnerIds ?? run.pending?.winnerIds ?? [],
      players: Object.entries(run.players).map(([playerId, p]) => ({ playerId, name: p.name })), serverNow: this.now() };
  }
  private async flushActivity(c: CentralContext) {
    const events = await this.runRef(c).collection('activity').orderBy('revision').get();
    for (const event of events.docs) {
      const data = event.data() as { context: CentralContext; eventId: string };
      await this.gateway.activity(data.context, data.eventId);
      await event.ref.delete();
    }
  }
  async progress(c: CentralContext) {
    const ref = this.runRef(c);
    await this.flushActivity(c);
    await this.db.runTransaction(async tx => {
      const run = (await tx.get(ref)).data() as EmbeddedRun | undefined;
      if (!run) return;
      const next = confirmRun(run, this.now());
      if (next !== run) tx.set(ref, next);
    });
    let run = (await ref.get()).data() as EmbeddedRun;
    if (run.phase !== 'settling' || !run.settlement || !run.offer) return;
    if (!run.settlement.receipt) {
      // Retry uses the same immutable run/offer/winners; Rewards owns the entire
      // atomic settlement and returns the same receipt after a lost response.
      await Promise.all(run.settlement.winnerIds.map(playerId => this.gateway.context({ ...c, playerId })));
      const result = await this.gateway.settle(c, run.offer.id, run.settlement.winnerIds);
      requireValue(id(result.receipt), 'Rewards did not return a settlement receipt.');
      await ref.update({ 'settlement.receipt': result.receipt });
      run = (await ref.get()).data() as EmbeddedRun;
    }
    await this.gateway.complete(c, run.settlement!.eventId, run.settlement!.winnerIds, run.settlement!.receipt!);
    await ref.update({ phase: 'complete' });
  }
  async maintain() {
    for (const phase of ['review', 'settling']) {
      const runs = await this.db.collection('embeddedRuns').where('phase', '==', phase).limit(100).get();
      for (const doc of runs.docs) {
        const run = doc.data() as EmbeddedRun;
        const [playerId, player] = Object.entries(run.players)[0];
        const c: CentralContext = { version: 1, sessionId: run.sessionId, runId: run.runId, playerId, displayName: player.name, expiresAt: 0 };
        try { await this.progress(c); } catch { /* Keep the durable outbox for the next retry. */ }
      }
    }
    const expired = await this.db.collection('embeddedConnections').where('expiresAt', '<=', this.now()).limit(300).get();
    if (!expired.empty) { const batch = this.db.batch(); expired.docs.forEach(doc => batch.delete(doc.ref)); await batch.commit(); }
  }
}
