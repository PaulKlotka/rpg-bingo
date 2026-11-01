import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { GAMES, MAX_MEMBERS, PRESENCE_TTL, SESSION_TTL, VERSION, VOTE_DURATION, type Ballot, type ConnectionContext, type Game, type GameCommand, type Grant, type PlayerCommand, type PlayerResponse, type Session, type SessionView } from '../../shared/types';
import { assert } from './errors';
import type { Store, Transaction } from './store';

interface Pointer { sessionId: string | null; }
interface Receipt { fingerprint: string; sessionId?: string; expiresAt: number; }
interface StoredGrant { appId: string; uid: string; sessionId: string; runId: string | null; nonce: string; expiresAt: number; }
export interface RegisteredApp { id: string; kind: 'game' | 'rewards'; origin: string; embedUrl?: string; }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => hash(JSON.stringify(value));
function text(value: unknown, label: string, max = 128): string {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max, 'invalid-argument', `${label} is required (maximum ${max} characters).`);
  return value;
}
function id(value: unknown, label = 'ID'): string {
  const result = text(value, label);
  assert(/^[\w-]+$/.test(result), 'invalid-argument', `${label} is invalid.`);
  return result;
}
function name(value: unknown): { name: string; nameKey: string } {
  const result = text(value, 'Player name', 100).normalize('NFKC').trim().replace(/\s+/g, ' ');
  assert(result.length > 0 && result.length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(result), 'invalid-argument', 'Enter a player name of 1–40 characters.');
  return { name: result, nameKey: result.toLocaleLowerCase('en-US') };
}
function active(s: Session, now: number) { return s.phase !== 'closed' && s.expiresAt > now; }
function touch(s: Session, now: number) { s.activityAt = now; s.expiresAt = now + SESSION_TTL; }
function connected(s: Session, uid: string, now: number) { return Object.values(s.members[uid]?.connections ?? {}).some(deadline => deadline > now); }

export class HubService {
  constructor(private store: Store, readonly games: Game[] = GAMES, readonly apps: RegisteredApp[] = [], private now: () => number = Date.now, private pick: (max: number) => number = randomInt) {}

  private view(s: Session, uid: string, now: number): SessionView {
    const { members, ...session } = s;
    const rewards = this.apps.find(a => a.kind === 'rewards' && a.embedUrl);
    return { session: { ...session, members: Object.values(members).map(m => ({ id: m.id, name: m.name, connected: connected(s, m.id, now) })) }, playerId: uid, expired: !active(s, now), serverNow: now, games: this.games, rewardsApp: rewards?.embedUrl ? { id: rewards.id, embedUrl: rewards.embedUrl } : null };
  }
  private save(tx: Transaction, s: Session) { s.revision++; tx.set(`sessions/${s.id}`, s); }
  private select(s: Session, now: number, initiator?: string) {
    const games = this.games.filter(g => g.ready);
    assert(games.length, 'failed-precondition', 'Games are still being connected. Your session is ready for them.');
    if (games.length === 1) { this.startRun(s, games[0].id, now); return; }
    const pool = [...games]; const options: string[] = [];
    while (pool.length && options.length < 3) options.push(pool.splice(this.pick(pool.length), 1)[0].id);
    s.phase = 'voting'; s.run = null;
    s.ballot = { id: randomUUID(), options, eligible: Object.keys(s.members).filter(uid => connected(s, uid, now) || uid === initiator), votes: {}, openedAt: now, closesAt: now + VOTE_DURATION };
  }
  private startRun(s: Session, gameId: string, now: number) {
    s.run = { id: randomUUID(), gameId, startedAt: now }; s.phase = 'playing'; s.ballot = null;
  }
  private settle(s: Session, now: number): boolean {
    const b = s.ballot;
    if (!active(s, now) || s.phase !== 'voting' || !b) return false;
    // Explicit departures remove eligibility; disconnection alone waits for the deadline.
    b.eligible = b.eligible.filter(uid => !!s.members[uid]);
    if (now < b.closesAt && (!b.eligible.length || !b.eligible.every(uid => !!b.votes[uid]))) return false;
    const counts = b.options.map(gameId => ({ gameId, count: b.eligible.filter(uid => b.votes[uid] === gameId).length }));
    const max = Math.max(...counts.map(c => c.count));
    const winners = counts.filter(c => c.count === max);
    this.startRun(s, winners[this.pick(winners.length)].gameId, now);
    return true;
  }
  private async session(tx: Transaction, uid: string, sessionId: string, now: number, allowExpired = false): Promise<Session> {
    id(sessionId, 'Session ID');
    const [s, pointer] = await Promise.all([tx.get<Session>(`sessions/${sessionId}`), tx.get<Pointer>(`players/${uid}`)]);
    assert(s && s.members[uid] && pointer?.sessionId === sessionId, 'permission-denied', 'You are no longer in this session.');
    assert(allowExpired || active(s, now), 'failed-precondition', 'This session has expired. Create or join a new session.');
    return s;
  }
  private async detach(tx: Transaction, uid: string, pointer: Pointer | null, now: number) {
    if (!pointer?.sessionId) return;
    const previous = await tx.get<Session>(`sessions/${pointer.sessionId}`);
    if (!previous?.members[uid]) return;
    delete previous.members[uid];
    if (previous.ballot) { previous.ballot.eligible = previous.ballot.eligible.filter(v => v !== uid); delete previous.ballot.votes[uid]; }
    if (!Object.keys(previous.members).length) previous.phase = 'closed';
    else this.settle(previous, now);
    this.save(tx, previous);
  }

  async player(uid: string, command: PlayerCommand): Promise<PlayerResponse> {
    id(uid, 'Player ID');
    assert(command && typeof command === 'object', 'invalid-argument', 'A command is required.');
    return this.store.transaction(async tx => {
      const now = this.now();
      const pointer = await tx.get<Pointer>(`players/${uid}`);
      if (command.action === 'current') {
        if (!pointer?.sessionId) return null;
        const s = await tx.get<Session>(`sessions/${pointer.sessionId}`);
        if (!s?.members[uid]) { tx.set(`players/${uid}`, { sessionId: null }); return null; }
        if (this.settle(s, now)) this.save(tx, s);
        return this.view(s, uid, now);
      }
      if (command.action === 'create' || command.action === 'join') {
        const requestId = id(command.requestId, 'Request ID');
        const receiptPath = `receipts/${hash(`${uid}:${requestId}`)}`;
        const prior = await tx.get<Receipt>(receiptPath);
        const fp = fingerprint(command);
        if (prior) {
          assert(prior.fingerprint === fp, 'already-exists', 'This request ID was already used for another operation.');
          assert(pointer?.sessionId === prior.sessionId, 'failed-precondition', 'This invitation request has already been completed.');
          return this.view(await this.session(tx, uid, prior.sessionId!, now, true), uid, now);
        }
        const display = name(command.name);
        let s: Session;
        if (command.action === 'create') {
          // 60 random bits; reserve the code transactionally and retry on collision.
          const code = randomBytes(8).toString('hex').slice(0, 15).toUpperCase();
          assert(!(await tx.get(`codes/${code}`)), 'already-exists', 'Please try creating the session again.');
          s = { id: randomUUID(), code, createdAt: now, activityAt: now, expiresAt: now + SESSION_TTL, phase: 'lobby', members: {}, ballot: null, run: null, history: [], revision: 0 };
          tx.set(`codes/${code}`, { sessionId: s.id, expiresAt: s.expiresAt });
        } else {
          const code = text(command.code, 'Session code', 32).replace(/[\s-]/g, '').toUpperCase();
          assert(/^[A-F0-9]{15}$/.test(code), 'invalid-argument', 'Enter the 15-character session code from your party.');
          const lookup = await tx.get<{ sessionId: string }>(`codes/${code}`);
          const found = lookup ? await tx.get<Session>(`sessions/${lookup.sessionId}`) : null;
          assert(found && active(found, now), 'not-found', 'That session does not exist or has expired.');
          s = found;
          if (s.members[uid]) return this.view(s, uid, now);
          assert(Object.keys(s.members).length < MAX_MEMBERS, 'resource-exhausted', `This session is full (${MAX_MEMBERS} players).`);
        }
        assert(!Object.values(s.members).some(m => m.nameKey === display.nameKey), 'already-exists', 'That name is already taken in this session. Choose another.');
        // Validate destination before atomically leaving the old session.
        await this.detach(tx, uid, pointer, now);
        s.members[uid] = { id: uid, ...display, joinedAt: now, connections: {} };
        touch(s, now); this.save(tx, s);
        tx.set(`players/${uid}`, { sessionId: s.id });
        tx.set(receiptPath, { fingerprint: fp, sessionId: s.id, expiresAt: now + 7 * SESSION_TTL });
        return this.view(s, uid, now);
      }
      assert('sessionId' in command, 'invalid-argument', 'Unknown command.');
      if (command.action === 'leave') {
        id(command.sessionId, 'Session ID'); id(command.requestId, 'Request ID');
        // A delayed leave from another tab cannot remove a newer membership.
        if (pointer?.sessionId === command.sessionId) {
          await this.detach(tx, uid, pointer, now); tx.set(`players/${uid}`, { sessionId: null });
        }
        return null;
      }
      const s = await this.session(tx, uid, command.sessionId, now, command.action === 'presence');
      if (command.action === 'presence') {
        const connectionId = id(command.connectionId, 'Connection ID');
        assert(typeof command.connected === 'boolean', 'invalid-argument', 'Connection state is required.');
        if (active(s, now)) {
          const connections = s.members[uid].connections;
          for (const [key, expiry] of Object.entries(connections)) if (expiry <= now) delete connections[key];
          if (command.connected) {
            assert(connections[connectionId] || Object.keys(connections).length < 8, 'resource-exhausted', 'Too many open tabs.');
            connections[connectionId] = now + PRESENCE_TTL;
          } else delete connections[connectionId];
          this.settle(s, now); this.save(tx, s);
        }
        return this.view(s, uid, now);
      }
      if (command.action === 'connect') return this.connect(tx, s, uid, command, now);
      const requestId = id(command.requestId, 'Request ID');
      const path = `receipts/${hash(`${uid}:${requestId}`)}`;
      const prior = await tx.get<Receipt>(path); const fp = fingerprint(command);
      if (prior) { assert(prior.fingerprint === fp, 'already-exists', 'Request ID already used.'); return this.view(s, uid, now); }
      if (command.action === 'start') {
        assert(s.phase === 'lobby', 'failed-precondition', 'The session has already started.');
        // Starting is allowed to every member, with no creator privileges.
        this.select(s, now, uid);
      } else if (command.action === 'vote') {
        const b: Ballot | null = s.ballot;
        assert(s.phase === 'voting' && b && b.id === command.ballotId && now < b.closesAt, 'failed-precondition', 'That vote has ended.');
        assert(b.eligible.includes(uid), 'permission-denied', 'You joined after voting began. You will join the selected game.');
        assert(b.options.includes(command.gameId), 'invalid-argument', 'Choose one of the offered games.');
        assert(!b.votes[uid], 'already-exists', 'Your vote has already been cast.');
        b.votes[uid] = command.gameId; this.settle(s, now);
      } else assert(false, 'invalid-argument', 'Unknown command.');
      touch(s, now); this.save(tx, s);
      tx.set(path, { fingerprint: fp, expiresAt: now + 7 * SESSION_TTL });
      return this.view(s, uid, now);
    });
  }

  private async connect(tx: Transaction, s: Session, uid: string, command: Extract<PlayerCommand, { action: 'connect' }>, now: number): Promise<Grant> {
    const app = this.apps.find(a => a.id === command.appId);
    assert(app, 'permission-denied', 'That application is not connected yet.');
    if (app.kind === 'game') assert(s.phase === 'playing' && s.run?.gameId === app.id && s.run.id === command.runId, 'failed-precondition', 'That game is not active.');
    const nonce = id(command.nonce, 'Connection nonce'); const token = randomBytes(32).toString('base64url');
    const grant: StoredGrant = { appId: app.id, uid, sessionId: s.id, runId: app.kind === 'game' ? s.run!.id : null, nonce, expiresAt: now + 60_000 };
    tx.set(`grants/${hash(token)}`, grant);
    return { token, expiresAt: grant.expiresAt };
  }

  async game(appId: string, command: GameCommand): Promise<unknown> {
    const app = this.apps.find(a => a.id === appId);
    assert(app, 'permission-denied', 'Application is not registered.');
    assert(command && typeof command === 'object', 'invalid-argument', 'A command is required.');
    return this.store.transaction(async tx => {
      const now = this.now();
      if (command.action === 'exchange') {
        const token = text(command.token, 'Connection grant');
        const path = `grants/${hash(token)}`; const grant = await tx.get<StoredGrant>(path);
        assert(grant && grant.appId === appId && grant.nonce === command.nonce && grant.expiresAt > now, 'permission-denied', 'Connection grant is invalid or expired.');
        const s = await this.session(tx, grant.uid, grant.sessionId, now);
        if (app.kind === 'game') assert(s.run?.id === grant.runId && s.run.gameId === appId && s.phase === 'playing', 'failed-precondition', 'That game has ended.');
        tx.delete(path);
        return this.context(s, grant.uid, app.kind);
      }
      assert('sessionId' in command, 'invalid-argument', 'Unknown integration command.');
      const sid = id(command.sessionId, 'Session ID');
      const s = await tx.get<Session>(`sessions/${sid}`);
      assert(s && active(s, now), 'failed-precondition', 'Session has expired or closed.');
      if (command.action === 'context') {
        const member = await this.session(tx, id(command.playerId, 'Player ID'), sid, now);
        if (app.kind === 'game') assert(member.run?.gameId === appId && member.run.id === command.runId, 'permission-denied', 'Game instance is not active.');
        if (app.kind === 'rewards' && command.runId) assert(member.phase === 'playing' && member.run?.id === command.runId && member.run.gameId === command.gameId, 'permission-denied', 'Game instance is not active.');
        return this.context(member, command.playerId, command.runId ? 'game' : app.kind);
      }
      const eventId = id(command.eventId, 'Event ID');
      const path = `receipts/${hash(`${appId}:${sid}:${eventId}`)}`;
      const prior = await tx.get<Receipt>(path); const fp = fingerprint(command);
      if (prior) { assert(prior.fingerprint === fp, 'already-exists', 'Event ID already used with different data.'); return { accepted: true }; }
      if (command.action === 'activity') {
        await this.session(tx, id(command.playerId, 'Player ID'), sid, now);
        if (app.kind === 'game') assert(s.phase === 'playing' && s.run?.gameId === appId && s.run.id === command.runId, 'permission-denied', 'Game instance is not active.');
      } else if (command.action === 'complete') {
        assert(app.kind === 'game' && s.phase === 'playing' && s.run?.gameId === appId && s.run.id === command.runId, 'permission-denied', 'Game instance is not active.');
        assert(Array.isArray(command.winnerIds) && command.winnerIds.length <= MAX_MEMBERS && new Set(command.winnerIds).size === command.winnerIds.length && command.winnerIds.every(uid => typeof uid === 'string' && !!s.members[uid]), 'invalid-argument', 'Winners must be current session members.');
        text(command.rewardsReceipt, 'Reward settlement receipt', 256);
        s.history = [...s.history, { runId: s.run.id, gameId: appId, completedAt: now, winnerIds: command.winnerIds }].slice(-100);
        this.select(s, now);
      } else assert(false, 'invalid-argument', 'Unknown integration command.');
      touch(s, now); this.save(tx, s);
      tx.set(path, { fingerprint: fp, expiresAt: now + 7 * SESSION_TTL });
      return { accepted: true };
    });
  }
  private context(s: Session, uid: string, kind: RegisteredApp['kind']): ConnectionContext {
    return { version: VERSION, playerId: uid, displayName: s.members[uid].name, sessionId: s.id, runId: kind === 'game' ? s.run?.id ?? null : null, expiresAt: s.expiresAt };
  }
  async settleSession(sessionId: string) {
    return this.store.transaction(async tx => {
      const s = await tx.get<Session>(`sessions/${sessionId}`);
      if (s && this.settle(s, this.now())) this.save(tx, s);
    });
  }
}
