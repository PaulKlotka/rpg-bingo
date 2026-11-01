import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubService, type RegisteredApp } from '../../functions/src/service';
import { PRESENCE_TTL, SESSION_TTL, VOTE_DURATION, type Game, type Grant, type Session, type SessionView } from '../../shared/types';
import { acceptsEmbedMessage } from '../../shared/embed';
import { MemoryStore } from '../helpers';
const games: Game[] = ['bingo', 'dice', 'cards', 'trivia'].map(id => ({ id, name: id, description: id, ready: true }));
const apps: RegisteredApp[] = [...games.map(g => ({ id: g.id, kind: 'game' as const, origin: 'https://example.com' })), { id: 'rpg-rewards', kind: 'rewards', origin: 'https://rewards.example.com' }];
let seq = 0; const req = () => `request-${++seq}`;
function fixture(catalog = games) {
  const store = new MemoryStore(); let now = 1_000_000;
  const service = new HubService(store, catalog, apps, () => now, () => 0);
  const create = async (uid = 'alice', name = uid) => await service.player(uid, { action: 'create', name, requestId: req() }) as SessionView;
  const join = async (v: SessionView, uid: string, name = uid) => await service.player(uid, { action: 'join', name, code: v.session.code, requestId: req() }) as SessionView;
  const presence = async (v: SessionView, uid: string, connected = true, connectionId = uid) => await service.player(uid, { action: 'presence', sessionId: v.session.id, connectionId, connected }) as SessionView;
  const start = async (v: SessionView, uid = 'alice') => await service.player(uid, { action: 'start', sessionId: v.session.id, requestId: req() }) as SessionView;
  const vote = async (v: SessionView, uid: string, gameId = v.session.ballot!.options[0]) => await service.player(uid, { action: 'vote', sessionId: v.session.id, ballotId: v.session.ballot!.id, gameId, requestId: req() }) as SessionView;
  return { store, service, create, join, presence, start, vote, advance: (ms: number) => { now += ms; }, now: () => now };
}
test('guest creation, normalized names and no owner role', async () => {
  const f = fixture(); const v = await f.create('alice', '  Alice   Smith ');
  assert.equal(v.session.members[0].name, 'Alice Smith'); assert.equal(v.session.expiresAt, f.now() + SESSION_TTL);
  assert.equal('ownerId' in v.session, false); assert.match(v.session.code, /^[A-F0-9]{15}$/);
});
test('names unique under case, Unicode normalization and whitespace; failed switch preserves old session', async () => {
  const f = fixture(); const a = await f.create('alice', 'Alice'); const b = await f.create('bob');
  await assert.rejects(f.join(a, 'bob', ' ＡＬＩＣＥ '), /already taken/);
  assert.equal((await f.service.player('bob', { action: 'current' }) as SessionView).session.id, b.session.id);
});
test('single membership and stale leave cannot remove a newer session', async () => {
  const f = fixture(); const a = await f.create(); await f.join(a, 'bob'); const b = await f.create('charlie'); await f.join(b, 'bob');
  await f.service.player('bob', { action: 'leave', sessionId: a.session.id, requestId: req() });
  assert.equal((await f.service.player('bob', { action: 'current' }) as SessionView).session.id, b.session.id);
  assert.deepEqual((await f.service.player('alice', { action: 'current' }) as SessionView).session.members.map(m => m.id), ['alice']);
});
test('any member can start, even after creator leaves', async () => {
  const f = fixture(); const a = await f.create(); await f.join(a, 'bob');
  await f.service.player('alice', { action: 'leave', sessionId: a.session.id, requestId: req() });
  const v = await f.start(a, 'bob'); assert.equal(v.session.phase, 'voting');
});
test('only ready games are offered, exactly three distinct options', async () => {
  const f = fixture([...games, { id: 'pending', name: 'Pending', description: '', ready: false }]); const a = await f.create();
  const v = await f.start(a); assert.equal(v.session.ballot!.options.length, 3); assert.equal(new Set(v.session.ballot!.options).size, 3); assert.ok(!v.session.ballot!.options.includes('pending'));
});
test('one ready game auto starts; zero ready games remain in lobby', async () => {
  const one = fixture(games.slice(0, 1)); const v = await one.start(await one.create()); assert.equal(v.session.phase, 'playing'); assert.equal(v.session.run!.gameId, 'bingo');
  const zero = fixture([]); const a = await zero.create(); await assert.rejects(zero.start(a), /still being connected/);
  assert.equal((await zero.service.player('alice', { action: 'current' }) as SessionView).session.phase, 'lobby');
});
test('two ready games offer both', async () => { const f = fixture(games.slice(0, 2)); const v = await f.start(await f.create()); assert.equal(v.session.ballot!.options.length, 2); });
test('only connected members at vote start are eligible; late joins enter selected run', async () => {
  const f = fixture(); const a = await f.create(); await f.join(a, 'bob'); await f.join(a, 'away'); await f.presence(a, 'bob');
  const v = await f.start(a); assert.deepEqual(v.session.ballot!.eligible.sort(), ['alice', 'bob']);
  await f.join(a, 'late'); await assert.rejects(f.vote(v, 'late'), /after voting/);
  await f.vote(v, 'alice'); const done = await f.vote(v, 'bob'); assert.equal(done.session.phase, 'playing'); assert.ok(done.session.members.some(m => m.id === 'late'));
});
test('voting ends at 30 seconds with no votes and selects a random offered game', async () => {
  const f = fixture(); const v = await f.start(await f.create()); f.advance(VOTE_DURATION);
  const done = await f.service.player('alice', { action: 'current' }) as SessionView;
  assert.equal(done.session.phase, 'playing'); assert.equal(done.session.run!.gameId, v.session.ballot!.options[0]);
  assert.equal(done.session.expiresAt, v.session.expiresAt, 'automatic transitions do not extend inactivity');
});
test('majority wins and ties use the injected random choice', async () => {
  const f = fixture(); const a = await f.create(); for (const uid of ['bob', 'charlie']) { await f.join(a, uid); await f.presence(a, uid); }
  const v = await f.start(a); const [x, y] = v.session.ballot!.options;
  await f.vote(v, 'alice', x); await f.vote(v, 'bob', y); const done = await f.vote(v, 'charlie', y); assert.equal(done.session.run!.gameId, y);
  const tie = fixture(); const b = await tie.create(); await tie.join(b, 'bob'); await tie.presence(b, 'bob'); const ballot = await tie.start(b);
  await tie.vote(ballot, 'alice', ballot.session.ballot!.options[0]); const tied = await tie.vote(ballot, 'bob', ballot.session.ballot!.options[1]); assert.equal(tied.session.run!.gameId, ballot.session.ballot!.options[0]);
});
test('disconnected voters wait for timeout; departing voters are removed', async () => {
  const f = fixture(); const a = await f.create(); await f.join(a, 'bob'); await f.presence(a, 'bob'); const v = await f.start(a);
  await f.presence(a, 'bob', false); const waiting = await f.vote(v, 'alice'); assert.equal(waiting.session.phase, 'voting');
  await f.service.player('bob', { action: 'leave', sessionId: a.session.id, requestId: req() });
  assert.equal((await f.service.player('alice', { action: 'current' }) as SessionView).session.phase, 'playing');
});
test('presence expires and multiple tabs do not disconnect each other; reads do not extend session', async () => {
  const f = fixture(); const a = await f.create(); await f.presence(a, 'alice', true, 'tab1'); await f.presence(a, 'alice', true, 'tab2');
  const v = await f.presence(a, 'alice', false, 'tab1'); assert.equal(v.session.members[0].connected, true); assert.equal(v.session.expiresAt, a.session.expiresAt);
  f.advance(PRESENCE_TTL); const away = await f.service.player('alice', { action: 'current' }) as SessionView; assert.equal(away.session.members[0].connected, false); assert.equal(away.session.expiresAt, a.session.expiresAt);
});
test('new members extend shared expiry; repeated joins and create retries do not', async () => {
  const f = fixture(); const command = { action: 'create' as const, name: 'alice', requestId: req() }; const a = await f.service.player('alice', command) as SessionView;
  f.advance(1000); assert.equal((await f.service.player('alice', command) as SessionView).session.expiresAt, a.session.expiresAt);
  const b = await f.join(a, 'bob'); assert.equal(b.session.expiresAt, f.now() + SESSION_TTL); f.advance(1000);
  const repeat = await f.join(a, 'bob'); assert.equal(repeat.session.expiresAt, b.session.expiresAt);
});
test('expired session blocks mutation, join and grant, independent of cleanup', async () => {
  const f = fixture(); const a = await f.create(); f.advance(SESSION_TTL);
  assert.equal((await f.service.player('alice', { action: 'current' }) as SessionView).expired, true);
  await assert.rejects(f.start(a), /expired/); await assert.rejects(f.join(a, 'bob'), /expired/);
  await assert.rejects(f.service.player('alice', { action: 'connect', sessionId: a.session.id, appId: 'rpg-rewards', nonce: 'nonce' }), /expired/);
  await f.service.player('alice', { action: 'leave', sessionId: a.session.id, requestId: req() }); assert.equal(await f.service.player('alice', { action: 'current' }), null);
});
test('concurrent unique-name joins and simultaneous membership switches are atomic', async () => {
  const f = fixture(); const a = await f.create(); const b = await f.create('bob');
  const results = await Promise.allSettled([f.join(a, 'x', 'Same'), f.join(a, 'y', 'same')]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await Promise.all([f.join(a, 'switcher'), f.join(b, 'switcher')]);
  const records = [...f.store.data].filter(([key, value]) => key.startsWith('sessions/') && !!(value as Session).members.switcher); assert.equal(records.length, 1);
});
test('grant is scoped, single-use, expires and does not extend activity', async () => {
  const f = fixture(games.slice(0, 1)); const a = await f.start(await f.create());
  const cmd = { action: 'connect' as const, sessionId: a.session.id, appId: 'bingo', runId: a.session.run!.id, nonce: 'nonce' };
  const grant = await f.service.player('alice', cmd) as Grant;
  await assert.rejects(f.service.game('dice', { action: 'exchange', token: grant.token, nonce: 'nonce' }), /invalid/);
  await assert.rejects(f.service.game('bingo', { action: 'exchange', token: grant.token, nonce: 'wrong' }), /invalid/);
  const context = await f.service.game('bingo', { action: 'exchange', token: grant.token, nonce: 'nonce' }) as { playerId: string }; assert.equal(context.playerId, 'alice');
  await assert.rejects(f.service.game('bingo', { action: 'exchange', token: grant.token, nonce: 'nonce' }), /invalid/);
  const expired = await f.service.player('alice', cmd) as Grant; f.advance(60_000); await assert.rejects(f.service.game('bingo', { action: 'exchange', token: expired.token, nonce: 'nonce' }), /expired/);
  assert.equal((await f.service.player('alice', { action: 'current' }) as SessionView).session.expiresAt, a.session.expiresAt);
});
test('switching sessions revokes previously issued grants', async () => {
  const f = fixture(); const a = await f.create(); const grant = await f.service.player('alice', { action: 'connect', sessionId: a.session.id, appId: 'rpg-rewards', nonce: 'nonce' }) as Grant;
  await f.create(); await assert.rejects(f.service.game('rpg-rewards', { action: 'exchange', token: grant.token, nonce: 'nonce' }), /no longer/);
});
test('trusted completion starts next selection once; duplicate events cannot finish a newer run', async () => {
  const f = fixture(games.slice(0, 1)); const a = await f.start(await f.create());
  const cmd = { action: 'complete' as const, sessionId: a.session.id, runId: a.session.run!.id, eventId: req(), winnerIds: ['alice'], rewardsReceipt: 'settled-1' };
  await f.service.game('bingo', cmd); const next = await f.service.player('alice', { action: 'current' }) as SessionView;
  assert.notEqual(next.session.run!.id, a.session.run!.id); assert.equal(next.session.history.length, 1);
  f.advance(1000); await f.service.game('bingo', cmd); const duplicate = await f.service.player('alice', { action: 'current' }) as SessionView;
  assert.equal(duplicate.session.run!.id, next.session.run!.id); assert.equal(duplicate.session.expiresAt, next.session.expiresAt);
  await assert.rejects(f.service.game('bingo', { ...cmd, eventId: req() }), /not active/);
  await assert.rejects(f.service.game('bingo', { ...cmd, winnerIds: [] }), /different data/);
});
test('game activity extends once; wrong game, outsiders, and player completion are rejected', async () => {
  const f = fixture(games.slice(0, 1)); const a = await f.start(await f.create()); f.advance(1000);
  const cmd = { action: 'activity' as const, sessionId: a.session.id, playerId: 'alice', runId: a.session.run!.id, eventId: req() };
  await f.service.game('bingo', cmd); const extended = await f.service.player('alice', { action: 'current' }) as SessionView; assert.equal(extended.session.expiresAt, f.now() + SESSION_TTL);
  f.advance(1000); await f.service.game('bingo', cmd); assert.equal((await f.service.player('alice', { action: 'current' }) as SessionView).session.expiresAt, extended.session.expiresAt);
  await assert.rejects(f.service.game('dice', cmd), /not active/); await assert.rejects(f.service.game('bingo', { ...cmd, playerId: 'outsider', eventId: req() }), /no longer/);
  await assert.rejects(f.service.player('alice', { action: 'complete', sessionId: a.session.id } as never), /Request ID|Unknown/);
});
test('invalid names, malformed IDs and nonmember access are rejected', async () => {
  const f = fixture(); await assert.rejects(f.create('alice', '   '), /player name/); await assert.rejects(f.create('alice', 'Alice\u200B'), /player name/);
  await assert.rejects(f.service.player('../alice', { action: 'current' }), /invalid/); const a = await f.create(); await assert.rejects(f.start(a, 'outsider'), /no longer/);
});
test('transaction retries recheck expiration using a fresh server timestamp', async () => {
  const memory = new MemoryStore(); let now = 1000; let retry = false;
  const store = { async transaction<T>(fn: Parameters<MemoryStore['transaction']>[0]): Promise<T> {
    if (retry) {
      retry = false;
      await assert.rejects(memory.transaction(async tx => { await fn(tx); throw new Error('simulated contention'); }), /simulated contention/);
      now += SESSION_TTL;
    }
    return memory.transaction(fn) as Promise<T>;
  } };
  const service = new HubService(store, games.slice(0, 1), apps, () => now, () => 0);
  const a = await service.player('alice', { action: 'create', name: 'Alice', requestId: req() }) as SessionView;
  retry = true;
  await assert.rejects(service.player('alice', { action: 'start', sessionId: a.session.id, requestId: req() }), /expired/);
});
test('embed messages require the exact origin, window, nonce and protocol version', () => {
  const source = {} as Window; const data = { channel: 'between-turns', version: 1, type: 'ready', nonce: 'nonce' }; const event = { source, origin: 'https://game.example', data };
  assert.ok(acceptsEmbedMessage(event, event.origin, source, 'nonce'));
  assert.equal(acceptsEmbedMessage({ ...event, origin: 'https://evil.example' }, event.origin, source, 'nonce'), false);
  assert.equal(acceptsEmbedMessage(event, event.origin, {} as Window, 'nonce'), false);
  assert.equal(acceptsEmbedMessage(event, event.origin, source, 'other'), false);
  assert.equal(acceptsEmbedMessage({ ...event, data: { ...data, version: 2 } }, event.origin, source, 'nonce'), false);
});
