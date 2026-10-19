import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously, updateCurrentUser } from 'firebase/auth';
import { collection, connectFirestoreEmulator, disableNetwork, enableNetwork, doc, getDocFromServer, getDocsFromServer, getFirestore, onSnapshot, setDoc, terminate, updateDoc, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import type { Player, Room, RollReceipt } from '../../shared/multiplayer';
import { PRIZES } from '../../src/prizes';
import { getPattern, isPattern } from '../../functions/src/shared/patterns';
import { cleanupExpiredRooms } from '../../functions/src/cleanup';
import { SESSION_IDLE_MS } from '../../functions/src/shared/lifetime';

// Guard fixtures: admin access must never point at a real project.
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'demo-rpg-games';
const serverRequire = createRequire(new URL('../../functions/package.json', import.meta.url));
const adminApp = serverRequire('firebase-admin/app').initializeApp({ projectId: 'demo-rpg-games' }, 'integration-fixtures');
const admin = serverRequire('firebase-admin/firestore').getFirestore(adminApp);
const id = () => randomBytes(16).toString('hex');
const apps: FirebaseApp[] = [];
const dbs: Firestore[] = [];
async function client(name: string, signIn = true) {
  const app = initializeApp({ projectId: 'demo-rpg-games', apiKey: 'demo-key', appId: 'demo-app' }, `${name}-${id()}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  if (signIn) await signInAnonymously(auth);
  const db = getFirestore(app);
  dbs.push(db);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const functions = getFunctions(app, 'us-central1');
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  const callable = httpsCallable<Record<string, unknown>, any>(functions, 'gameCommand');
  return { app, auth, db, uid: auth.currentUser?.uid ?? '', call: async (data: Record<string, unknown>) => (await callable(data)).data };
}
type Client = Awaited<ReturnType<typeof client>>;
let a: Client, b: Client, c: Client, outsider: Client, anonymous: Client;
const roomData = async (roomId: string): Promise<Room> => (await admin.doc(`rooms/${roomId}`).get()).data();
const playerData = async (roomId: string, who: Client): Promise<Player> => (await admin.doc(`rooms/${roomId}/players/${who.uid}`).get()).data();
const awards = async (roomId: string, who: Client) => (await admin.collection(`rooms/${roomId}/players/${who.uid}/awards`).get()).docs.map((d: any) => d.data());
async function invite() {
  const roomId = id();
  await a.call({ action: 'create', roomId, name: 'Alpha' });
  return roomId;
}
async function shared() {
  const roomId = await invite();
  await b.call({ action: 'join', roomId, name: 'Beta' });
  await a.call({ action: 'start', roomId });
  return roomId;
}
async function send(who: Client, roomId: string, number: number, extra: Record<string, unknown> = {}) {
  const room = await roomData(roomId);
  const { holdBingo, ...payload } = extra;
  const receipt = await who.call({ action: 'roll', roomId, round: room.round, revision: room.revision, kind: 'physical', number, requestId: id(), ...payload }) as RollReceipt;
  if (!holdBingo) await settleBingo(roomId);
  return receipt;
}
// Fast-forward only emulator fixtures for existing post-win assertions. A separate
// test below exercises the real fifteen-second deadline without changing it.
async function settleBingo(roomId: string) {
  const room = await roomData(roomId);
  if (!room.pendingBingo) return;
  await admin.doc(`rooms/${roomId}`).update({ 'pendingBingo.confirmAt': Date.now() - 1 });
  await a.call({ action: 'confirm', roomId, round: room.round, pendingId: room.pendingBingo.requestId });
}
const rejectCode = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: any) => error.code === `functions/${code}` || error.code === code);
async function undo(who: Client, roomId: string, extra: Record<string, unknown> = {}) {
  const room = await roomData(roomId);
  return who.call({ action: 'undo', roomId, round: room.round, revision: room.revision, rollRequestId: room.undo?.requestId ?? id(), requestId: id(), ...extra });
}
const fixtureCard = () => Array.from({ length: 25 }, (_, i) => i === 12 ? null : i % 20 + 1);
async function seedCards(roomId: string, card = fixtureCard()) {
  await admin.doc(`rooms/${roomId}`).update({ pattern: 'single-line' });
  // Explicit synthetic cards make tied wins and races deterministic. Production has no fixture endpoint.
  for (const who of [a, b]) await admin.doc(`rooms/${roomId}/players/${who.uid}`).update({ card });
}

before(async () => {
  await fetch('http://127.0.0.1:9099/').catch(() => { throw new Error('Start npm run emulators before running multiplayer integration tests.'); });
  a = await client('alpha'); b = await client('beta'); c = await client('gamma');
  outsider = await client('outsider'); anonymous = await client('unauthenticated', false);
});

test('undo restores shared marks, count, last result and turn eligibility for everyone', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1); const before = await roomData(roomId);
  await send(b, roomId, 2);
  await undo(b, roomId);
  const after = await roomData(roomId);
  assert.deepEqual(after.marks, before.marks); assert.equal(after.rolls, before.rolls);
  assert.equal(after.lastSubmitter, a.uid); assert.deepEqual(after.lastAction, before.lastAction);
  assert.equal(after.pattern, before.pattern); assert.equal(after.prize, before.prize);
  assert.equal(after.undo, null); assert.equal(after.revision, before.revision + 2);
  await rejectCode(send(a, roomId, 3), 'failed-precondition');
  await send(b, roomId, 3);
  assert.deepEqual((await roomData(roomId)).marks, [1,3]);
});

test('undoing a repeated number retains earlier marks and undoing the first roll clears them', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1); await send(b, roomId, 1); await undo(b, roomId);
  assert.deepEqual((await roomData(roomId)).marks, [1]);
  const fresh = await shared(); await seedCards(fresh);
  await send(a, fresh, 1); await undo(a, fresh);
  const room = await roomData(fresh);
  assert.deepEqual(room.marks, []); assert.equal(room.rolls, 0);
  assert.equal(room.lastSubmitter, null); assert.equal(room.lastAction, null);
  await send(a, fresh, 2);
});

test('only the latest submitter may undo; older tokens and nonmembers are rejected', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1); const first = (await roomData(roomId)).undo!;
  await rejectCode(undo(b, roomId), 'failed-precondition');
  await rejectCode(undo(outsider, roomId), 'permission-denied');
  await send(b, roomId, 2);
  await rejectCode(undo(a, roomId, { rollRequestId: first.requestId }), 'failed-precondition');
  assert.deepEqual((await roomData(roomId)).marks, [1,2]);
});

test('concurrent undo retries are idempotent and original roll retries cannot reapply marks', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const before = await roomData(roomId);
  const rollId = id();
  const payload = { action: 'roll', roomId, round: before.round, revision: before.revision, kind: 'physical', number: 1, requestId: rollId };
  const original = await a.call(payload);
  const current = await roomData(roomId);
  const request = { action: 'undo', roomId, round: current.round, revision: current.revision, rollRequestId: rollId, requestId: id() };
  const [first, second] = await Promise.all([a.call(request), a.call(request)]);
  assert.deepEqual(first, second);
  assert.deepEqual(await a.call(payload), original);
  const after = await roomData(roomId);
  assert.deepEqual(after.marks, []); assert.equal(after.revision, current.revision + 1);
  await rejectCode(undo(a, roomId, { requestId: request.requestId, rollRequestId: id() }), 'invalid-argument');
});

test('undo racing another player’s roll accepts only one action against the same revision', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1); await send(b, roomId, 2);
  const room = await roomData(roomId);
  const results = await Promise.allSettled([
    b.call({ action: 'undo', roomId, round: room.round, revision: room.revision, rollRequestId: room.undo!.requestId, requestId: id() }),
    a.call({ action: 'roll', roomId, round: room.round, revision: room.revision, kind: 'physical', number: 3, requestId: id() }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const after = await roomData(roomId);
  assert.equal(after.revision, room.revision + 1);
  assert.ok(JSON.stringify(after.marks) === '[1]' || JSON.stringify(after.marks) === '[1,2,3]');
});

test('a winning roll cannot be undone or revoke prizes after advancing the round', async () => {
  const roomId = await shared();
  await seedCards(roomId, Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1));
  const requestId = id(); await send(a, roomId, 1, { requestId });
  const before = await roomData(roomId);
  assert.equal(before.undo, null);
  await rejectCode(undo(a, roomId, { rollRequestId: requestId }), 'failed-precondition');
  assert.deepEqual(await roomData(roomId), before);
  assert.equal((await awards(roomId, a)).length, 1);
  assert.equal((await awards(roomId, b)).length, 1);
});

test('bingo review freezes every card, defers awards, blocks early confirmation and allows winning-roll undo', async () => {
  const roomId = await shared();
  await seedCards(roomId, Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1));
  const before = await roomData(roomId);
  const originalCard = (await playerData(roomId, a)).card;
  await send(a, roomId, 1, { holdBingo: true });
  const pending = await roomData(roomId);
  assert.equal(pending.round, 1); assert.deepEqual(pending.marks, [1]);
  assert.equal(pending.prize, before.prize); assert.equal(pending.pattern, before.pattern);
  assert.deepEqual((await playerData(roomId, a)).card, originalCard);
  assert.equal((await awards(roomId, a)).length, 0); assert.equal((await awards(roomId, b)).length, 0);
  assert.equal(pending.pendingBingo!.result.winners.length, 2);
  const confirmation = { action: 'confirm', roomId, round: 1, pendingId: pending.pendingBingo!.requestId };
  await rejectCode(b.call(confirmation), 'failed-precondition');
  await rejectCode(outsider.call(confirmation), 'permission-denied');
  await rejectCode(b.call({ ...confirmation, pendingId: id() }), 'failed-precondition');
  await rejectCode(send(b, roomId, 2), 'failed-precondition');
  await rejectCode(undo(b, roomId), 'failed-precondition');
  await undo(a, roomId);
  const restored = await roomData(roomId);
  assert.equal(restored.pendingBingo, null); assert.equal(restored.round, 1);
  assert.deepEqual(restored.marks, before.marks); assert.equal(restored.lastSubmitter, before.lastSubmitter);
  assert.deepEqual((await playerData(roomId, a)).card, originalCard);
  await rejectCode(a.call(confirmation), 'failed-precondition');
  assert.equal((await awards(roomId, a)).length, 0);
});

test('real fifteen-second review rejects late undo and confirms tied awards exactly once under concurrent retries', async () => {
  const roomId = await shared();
  await seedCards(roomId, Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1));
  const started = Date.now();
  await send(a, roomId, 1, { holdBingo: true });
  const pending = await roomData(roomId);
  assert.ok(pending.pendingBingo!.confirmAt >= started + 15000);
  await c.call({ action: 'join', roomId, name: 'Gamma' });
  assert.equal((await playerData(roomId, c)).card, null);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, pending.pendingBingo!.confirmAt - Date.now()) + 30));
  await rejectCode(undo(a, roomId), 'failed-precondition');
  const payload = { action: 'confirm', roomId, round: 1, pendingId: pending.pendingBingo!.requestId };
  await Promise.all([a.call(payload), b.call(payload), c.call(payload), a.call(payload)]);
  const next = await roomData(roomId);
  assert.equal(next.round, 2); assert.equal(next.pendingBingo, null); assert.equal(next.undo, null);
  assert.equal(next.revision, pending.revision + 2); // One join and exactly one confirmation.
  assert.deepEqual(next.marks, []);
  for (const who of [a,b]) assert.equal((await awards(roomId, who)).length, 1);
  assert.equal((await awards(roomId, c)).length, 0);
  assert.equal((await playerData(roomId, c)).eligibleRound, 2);
  const final = await roomData(roomId);
  await a.call(payload); assert.deepEqual(await roomData(roomId), final);
  await rejectCode(undo(a, roomId), 'failed-precondition');
});

test('expired sessions and departed players cannot undo', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1);
  await admin.doc(`rooms/${roomId}`).update({ expiresAt: Date.now() - 1 });
  await rejectCode(undo(a, roomId), 'failed-precondition');
  const fresh = await shared(); await seedCards(fresh); await send(a, fresh, 1);
  await a.call({ action: 'leave', roomId: fresh });
  await rejectCode(undo(a, fresh), 'permission-denied');
});
after(async () => {
  await Promise.all(dbs.map(db => terminate(db)));
  await Promise.all(apps.map(app => deleteApp(app)));
  await admin.terminate();
  await adminApp.delete();
});

test('unauthenticated function calls cannot create sessions', async () => {
  const roomId = id();
  await rejectCode(anonymous.call({ action: 'create', roomId, name: 'Nobody' }), 'unauthenticated');
  assert.equal((await admin.doc(`rooms/${roomId}`).get()).exists, false);
});

test('waiting players may leave; repeat leaves and outsiders cannot remove another player', async () => {
  const roomId = await shared();
  await c.call({ action: 'join', roomId, name: 'Gamma' });
  await outsider.call({ action: 'leave', roomId, uid: a.uid });
  assert.equal((await roomData(roomId)).members.length, 3);
  await c.call({ action: 'leave', roomId });
  const after = await roomData(roomId);
  assert.deepEqual(after.members.map(m => m.uid), [a.uid,b.uid]);
  assert.equal((await playerData(roomId, c)).left, true);
  await assert.rejects(getDocFromServer(doc(c.db, 'rooms', roomId)), (error: any) => error.code === 'permission-denied');
  await c.call({ action: 'leave', roomId });
  assert.deepEqual(await roomData(roomId), after);
  await rejectCode(send(c, roomId, 1), 'permission-denied');
});

test('leaving transfers the host before shared play and a new session works normally', async () => {
  const roomId = await invite();
  await b.call({ action: 'join', roomId, name: 'Beta' });
  await a.call({ action: 'leave', roomId });
  assert.equal((await roomData(roomId)).creator, b.uid);
  await c.call({ action: 'join', roomId, name: 'Gamma' });
  await b.call({ action: 'start', roomId });
  assert.equal((await playerData(roomId, a)).card, null);
  const freshRoom = await invite();
  assert.notEqual(freshRoom, roomId);
  await b.call({ action: 'join', roomId: freshRoom, name: 'Beta' });
  await a.call({ action: 'start', roomId: freshRoom });
  assert.equal((await roomData(freshRoom)).phase, 'shared');
});

test('active departure preserves progress, pauses lone players, and retains earned prizes on rejoin', async () => {
  const roomId = await shared();
  await seedCards(roomId, Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1));
  await send(a, roomId, 1);
  const earned = await awards(roomId, a);
  const before = await roomData(roomId);
  const bCard = (await playerData(roomId, b)).card;
  await a.call({ action: 'leave', roomId });
  const after = await roomData(roomId);
  assert.equal(after.round, before.round); assert.deepEqual(after.marks, before.marks);
  assert.equal(after.pattern, before.pattern); assert.equal(after.prize, before.prize);
  assert.deepEqual((await playerData(roomId, b)).card, bCard);
  assert.deepEqual(await awards(roomId, a), earned);
  await rejectCode(send(b, roomId, 2), 'failed-precondition');
  await a.call({ action: 'join', roomId, name: 'Alpha' });
  assert.equal((await playerData(roomId, a)).left, false);
  assert.equal((await playerData(roomId, a)).eligibleRound, after.round);
  assert.equal((await playerData(roomId, a)).card!.length, 25);
  assert.deepEqual(await awards(roomId, a), earned);
});

test('an empty room closes and the same player can create a fresh invite', async () => {
  const roomId = await invite();
  await a.call({ action: 'leave', roomId });
  assert.equal((await roomData(roomId)).closed, true);
  await rejectCode(b.call({ action: 'join', roomId, name: 'Beta' }), 'failed-precondition');
  const freshRoom = await invite();
  assert.equal((await roomData(freshRoom)).closed, undefined);
});

test('room reads and repeated joins do not prolong expiry; accepted play does', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const nearExpiry = Date.now() + 60000;
  await admin.doc(`rooms/${roomId}`).update({ expiresAt: nearExpiry });
  await getDocFromServer(doc(a.db, 'rooms', roomId));
  await b.call({ action: 'join', roomId, name: 'Beta' });
  assert.equal((await roomData(roomId)).expiresAt, nearExpiry);
  await send(a, roomId, 1);
  assert.ok((await roomData(roomId)).expiresAt! > Date.now() + SESSION_IDLE_MS - 10000);
});

test('expired rooms reject joins, rolls, starts and prize use but still permit leaving', async () => {
  const roomId = await shared();
  await seedCards(roomId, Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1));
  await send(a, roomId, 1);
  await admin.doc(`rooms/${roomId}`).update({ expiresAt: Date.now() - 1 });
  await rejectCode(c.call({ action: 'join', roomId, name: 'Gamma' }), 'failed-precondition');
  await rejectCode(a.call({ action: 'start', roomId }), 'failed-precondition');
  await rejectCode(send(b, roomId, 2), 'failed-precondition');
  await rejectCode(a.call({ action: 'use', roomId, awardRound: 1, used: true }), 'failed-precondition');
  assert.equal((await awards(roomId, a))[0].used, false);
  await b.call({ action: 'leave', roomId });
  assert.equal((await playerData(roomId, b)).left, true);
});

test('cleanup removes the full expired room tree while retaining live sessions', async () => {
  const roomId = await shared();
  await seedCards(roomId, Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1));
  await send(a, roomId, 1);
  const liveRoom = await invite();
  await admin.doc(`rooms/${roomId}`).update({ expiresAt: Date.now() - 1 });
  await cleanupExpiredRooms(admin);
  assert.equal((await admin.doc(`rooms/${roomId}`).get()).exists, false);
  assert.equal((await admin.collection(`rooms/${roomId}/players`).get()).size, 0);
  assert.equal((await admin.collection(`rooms/${roomId}/players/${a.uid}/awards`).get()).size, 0);
  assert.equal((await admin.collection(`rooms/${roomId}/rounds`).get()).size, 0);
  assert.equal((await admin.collection(`rooms/${roomId}/commands`).get()).size, 0);
  assert.equal((await admin.doc(`rooms/${liveRoom}`).get()).exists, true);
});

test('inviting does not deal cards or permit shared play before two active participants', async () => {
  const roomId = await invite();
  assert.equal((await roomData(roomId)).phase, 'inviting');
  assert.equal((await playerData(roomId, a)).card, null);
  await rejectCode(a.call({ action: 'start', roomId }), 'failed-precondition');
  await b.call({ action: 'join', roomId, name: 'Beta' });
  assert.equal((await playerData(roomId, b)).card, null);
  await rejectCode(send(b, roomId, 1, { round: 1 }), 'failed-precondition');
  await rejectCode(b.call({ action: 'start', roomId }), 'permission-denied');
  assert.equal((await roomData(roomId)).phase, 'inviting');
});

test('host New Card starts shared play once and deals independently randomized cards', async () => {
  const roomId = await shared();
  const room = await roomData(roomId);
  assert.equal(room.phase, 'shared'); assert.equal(room.round, 1);
  assert.ok(isPattern(room.pattern));
  assert.ok(PRIZES.some(p => p.name === room.prize));
  for (const who of [a, b]) {
    const p = await playerData(roomId, who);
    assert.equal(p.eligibleRound, 1); assert.equal(p.card!.length, 25);
    assert.equal(p.card![12], null);
    const counts = Array.from({ length: 20 }, (_, i) => p.card!.filter(n => n === i + 1).length);
    assert.equal(counts.filter(count => count === 2).length, 4);
    assert.equal(counts.filter(count => count === 1).length, 16);
    assert.ok(p.card!.every((n, i) => i === 12 ? n === null : Number.isInteger(n) && n! >= 1 && n! <= 20));
  }
  const before = await playerData(roomId, a);
  await a.call({ action: 'start', roomId });
  assert.deepEqual(await playerData(roomId, a), before);
});

test('shared rolls add marks for all matching numbers and repeats never unmark', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1); await send(b, roomId, 1);
  const room = await roomData(roomId);
  assert.deepEqual(room.marks, [1]); assert.equal(room.rolls, 2);
  for (const who of [a, b]) {
    const p = await playerData(roomId, who);
    assert.equal(p.card!.filter(n => n !== null && room.marks.includes(n)).length, 2);
  }
});

test('one shared shape governs all players, ignores ordinary lines, and redraws after a tied pattern win', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await admin.doc(`rooms/${roomId}`).update({ pattern: 'windmill' });
  let turn = 0;
  for (const number of [1,2,3,4,5]) await send(turn++ % 2 ? b : a, roomId, number);
  assert.equal((await roomData(roomId)).round, 1);
  assert.equal((await roomData(roomId)).pattern, 'windmill');
  assert.equal((await awards(roomId, a)).length, 0);
  const card = fixtureCard();
  for (const number of new Set(getPattern('windmill').squares.map(i => card[i]).filter(n => n !== null))) {
    const room = await roomData(roomId);
    if (!room.marks.includes(number)) await send(turn++ % 2 ? b : a, roomId, number);
  }
  const next = await roomData(roomId);
  assert.equal(next.round, 2);
  assert.ok(isPattern(next.pattern));
  assert.equal(next.lastResult!.pattern, 'windmill');
  assert.equal(next.lastResult!.winners.length, 2);
  for (const who of [a,b]) {
    assert.equal((await awards(roomId, who)).length, 1);
    assert.equal((await playerData(roomId, who)).eligibleRound, 2);
  }
});

test('physical then virtual submissions by the same player are rejected without mutation', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1);
  const before = await roomData(roomId);
  await rejectCode(a.call({ action: 'roll', roomId, round: before.round, revision: before.revision, kind: 'virtual', requestId: id() }), 'failed-precondition');
  assert.deepEqual(await roomData(roomId), before);
});

test('virtual then physical submissions also enforce alternation', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const initial = await roomData(roomId);
  const result = await a.call({ action: 'roll', roomId, round: initial.round, revision: initial.revision, kind: 'virtual', requestId: id() });
  assert.ok(result.number >= 1 && result.number <= 20);
  const before = await roomData(roomId);
  await rejectCode(send(a, roomId, 3), 'failed-precondition');
  assert.deepEqual(await roomData(roomId), before);
});

test('mid-round joiners have no card, receive no retroactive marks, and cannot submit', async () => {
  const roomId = await shared(); await seedCards(roomId); await send(a, roomId, 1);
  await c.call({ action: 'join', roomId, name: 'Gamma' });
  const waiting = await playerData(roomId, c);
  assert.equal(waiting.card, null); assert.equal(waiting.eligibleRound, 2);
  const before = await roomData(roomId);
  await rejectCode(send(c, roomId, 2), 'failed-precondition');
  assert.deepEqual(await roomData(roomId), before);
});

test('a player joining an untouched round receives a fresh active card and shares its existing pattern', async () => {
  const roomId = await shared();
  const before = await roomData(roomId);
  const hostCard = (await playerData(roomId, a)).card;
  await c.call({ action: 'join', roomId, name: 'Gamma' });
  const joined = await playerData(roomId, c);
  assert.equal(joined.eligibleRound, before.round); assert.equal(joined.card!.length, 25);
  const after = await roomData(roomId);
  assert.equal(after.pattern, before.pattern); assert.equal(after.prize, before.prize);
  assert.deepEqual((await playerData(roomId, a)).card, hostCard);
  assert.deepEqual(after.marks, []);
  await send(c, roomId, 20, { holdBingo: true });
  assert.equal((await roomData(roomId)).lastSubmitter, c.uid);
});

test('join racing the first roll either joins untouched play or waits, without receiving a partially played card', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const room = await roomData(roomId);
  const results = await Promise.allSettled([
    c.call({ action: 'join', roomId, name: 'Gamma' }),
    a.call({ action: 'roll', roomId, round: room.round, revision: room.revision, kind: 'physical', number: 1, requestId: id() }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  const joined = await playerData(roomId, c); const after = await roomData(roomId);
  if (joined.eligibleRound === 1) assert.equal(joined.card!.length, 25);
  else { assert.equal(joined.eligibleRound, 2); assert.equal(joined.card, null); assert.deepEqual(after.marks, [1]); }
});

test('after the first roll is undone, a new player can join the now untouched round', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1); await undo(a, roomId);
  await c.call({ action: 'join', roomId, name: 'Gamma' });
  assert.equal((await playerData(roomId, c)).eligibleRound, 1);
  assert.equal((await playerData(roomId, c)).card!.length, 25);
});

test('concurrent requests by the same player cannot bypass turn enforcement', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const room = await roomData(roomId);
  const payload = { action: 'roll', roomId, round: room.round, revision: room.revision, kind: 'physical', number: 1 };
  const results = await Promise.allSettled([a.call({ ...payload, requestId: id() }), a.call({ ...payload, requestId: id() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await roomData(roomId)).rolls, 1);
});

test('two players can repeatedly alternate in a five-player room without a fixed order', async () => {
  const fifth = await client('fifth');
  const roomId = await invite();
  for (const [who, name] of [[b, 'Beta'], [c, 'Gamma'], [outsider, 'Delta'], [fifth, 'Echo']] as const) {
    await who.call({ action: 'join', roomId, name });
  }
  await a.call({ action: 'start', roomId });
  for (const who of [a, b, c, outsider, fifth]) {
    await admin.doc(`rooms/${roomId}/players/${who.uid}`).update({ card: fixtureCard() });
  }
  for (let entry = 0; entry < 8; entry++) {
    const who = entry % 2 === 0 ? a : b;
    await send(who, roomId, 1);
    const before = await roomData(roomId);
    await rejectCode(send(who, roomId, 1), 'failed-precondition');
    assert.deepEqual(await roomData(roomId), before);
  }
  const room = await roomData(roomId);
  assert.equal(room.members.length, 5);
  assert.equal(room.rolls, 8);
  assert.equal(room.lastSubmitter, b.uid);
  assert.deepEqual(room.marks, [1]);
  await send(c, roomId, 1);
  await send(a, roomId, 1);
  await send(b, roomId, 1);
  assert.equal((await roomData(roomId)).rolls, 11);
});

test('retrying one request concurrently is idempotent and never rolls twice', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const room = await roomData(roomId);
  const payload = { action: 'roll', roomId, round: room.round, revision: room.revision, kind: 'virtual', requestId: id() };
  const results = await Promise.all([a.call(payload), a.call(payload)]);
  assert.deepEqual(results[0], results[1]); assert.equal((await roomData(roomId)).rolls, 1);
  await rejectCode(a.call({ ...payload, kind: 'physical', number: 1 }), 'invalid-argument');
});

test('simultaneous different-player requests using an old revision accept only one', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const room = await roomData(roomId);
  const payload = { action: 'roll', roomId, round: room.round, revision: room.revision, kind: 'physical', number: 1 };
  const results = await Promise.allSettled([a.call({ ...payload, requestId: id() }), b.call({ ...payload, requestId: id() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await roomData(roomId)).rolls, 1);
});

test('one atomic tied win awards all winners once, admits waiters and resets everyone', async () => {
  const roomId = await shared(); await seedCards(roomId);
  await send(a, roomId, 1); await c.call({ action: 'join', roomId, name: 'Gamma' });
  await send(b, roomId, 2); await send(a, roomId, 3); await send(b, roomId, 4);
  const old = await roomData(roomId);
  const payload = { action: 'roll', roomId, round: old.round, revision: old.revision, kind: 'physical', number: 5, requestId: id() };
  const receipt = await a.call(payload);
  await settleBingo(roomId);
  const next = await roomData(roomId);
  assert.equal(next.round, 2); assert.equal(next.rolls, 0); assert.deepEqual(next.marks, []);
  assert.equal(next.lastSubmitter, a.uid);
  assert.deepEqual(new Set(next.lastResult!.winners.map(w => w.uid)), new Set([a.uid, b.uid]));
  assert.equal(next.lastResult!.prize, old.prize);
  for (const who of [a, b]) {
    const won = await awards(roomId, who);
    assert.equal(won.length, 1); assert.equal(won[0].prize, old.prize); assert.equal(won[0].used, false);
  }
  assert.equal((await awards(roomId, c)).length, 0);
  for (const who of [a, b, c]) { const p = await playerData(roomId, who); assert.equal(p.eligibleRound, 2); assert.equal(p.card!.length, 25); }
  assert.ok(PRIZES.some(p => p.name === next.prize));
  assert.deepEqual(await a.call(payload), receipt);
  assert.equal((await awards(roomId, a)).length, 1);
  await rejectCode(send(a, roomId, 1), 'failed-precondition');
  await rejectCode(b.call({ ...payload, requestId: id() }), 'aborted');
  assert.deepEqual(await roomData(roomId), next);
  await send(c, roomId, 20); // Any different active player can submit; no fixed order.
  assert.equal((await roomData(roomId)).lastSubmitter, c.uid);
});

test('used/unused prize updates belong to the authenticated owner and survive new rounds', async () => {
  const roomId = await shared();
  const allOnes = Array.from({ length: 25 }, (_, i) => i === 12 ? null : 1);
  await seedCards(roomId, allOnes); await send(a, roomId, 1);
  await a.call({ action: 'use', roomId, awardRound: 1, used: true, uid: b.uid });
  assert.equal((await awards(roomId, a))[0].used, true);
  assert.equal((await awards(roomId, b))[0].used, false);
  await a.call({ action: 'use', roomId, awardRound: 1, used: false });
  assert.equal((await awards(roomId, a))[0].used, false);
  await a.call({ action: 'use', roomId, awardRound: 1, used: true });
  await seedCards(roomId, allOnes); await send(b, roomId, 1);
  const won = await awards(roomId, a);
  assert.equal(won.length, 2); assert.deepEqual(won.map((w: any) => w.used), [true, false]);
});

test('reconnecting an authenticated client restores the same card and prizes', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const reconnect = await client('reconnect', false);
  await updateCurrentUser(reconnect.auth, a.auth.currentUser);
  assert.equal(reconnect.auth.currentUser!.uid, a.uid);
  const before = await getDocFromServer(doc(reconnect.db, 'rooms', roomId, 'players', a.uid));
  await disableNetwork(reconnect.db);
  await send(b, roomId, 1);
  await enableNetwork(reconnect.db);
  const after = await getDocFromServer(doc(reconnect.db, 'rooms', roomId, 'players', a.uid));
  assert.deepEqual(after.data(), before.data());
  const room = (await getDocFromServer(doc(reconnect.db, 'rooms', roomId))).data() as Room;
  assert.deepEqual(room.marks, [1]);
  assert.equal((await getDocsFromServer(collection(reconnect.db, 'rooms', roomId, 'players', a.uid, 'awards'))).size, 0);
});

test('separate authenticated clients receive the same live round revision', async () => {
  const roomId = await shared(); await seedCards(roomId);
  const changed = new Promise<Room>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('Live update not received')); }, 10000);
    const stop = onSnapshot(doc(b.db, 'rooms', roomId), snapshot => {
      const room = snapshot.data() as Room;
      if (room?.rolls === 1) { clearTimeout(timer); stop(); resolve(room); }
    }, reject);
  });
  const receipt = await send(a, roomId, 1);
  const live = await changed;
  assert.equal(live.revision, receipt.revision); assert.deepEqual(live.marks, [1]);
});

test('security rules deny fabricated rolls, cards, awards, member lists and other players’ private data', async () => {
  const roomId = await shared();
  await rejectCode(updateDoc(doc(a.db, 'rooms', roomId), { marks: [1, 2, 3] }), 'permission-denied');
  await rejectCode(updateDoc(doc(a.db, 'rooms', roomId, 'players', a.uid), { card: fixtureCard() }), 'permission-denied');
  await rejectCode(setDoc(doc(a.db, 'rooms', roomId, 'players', a.uid, 'awards', '1'), { prize: 'Steady Aim', used: false }), 'permission-denied');
  await rejectCode(getDocFromServer(doc(a.db, 'rooms', roomId, 'players', b.uid)), 'permission-denied');
  await rejectCode(getDocsFromServer(collection(a.db, 'rooms', roomId, 'players', b.uid, 'awards')), 'permission-denied');
  await rejectCode(getDocsFromServer(collection(a.db, 'rooms')), 'permission-denied');
  await rejectCode(getDocsFromServer(collection(a.db, 'rooms', roomId, 'players')), 'permission-denied');
  await rejectCode(getDocFromServer(doc(outsider.db, 'rooms', roomId)), 'permission-denied');
  await rejectCode(getDocFromServer(doc(anonymous.db, 'rooms', roomId)), 'permission-denied');
  assert.equal((await getDocFromServer(doc(a.db, 'rooms', roomId))).exists(), true);
});

test('invalid results, forged identity and stale revisions never mutate a room', async () => {
  const roomId = await shared();
  const before = await roomData(roomId);
  for (const number of [0, 21, 1.5, '4']) await rejectCode(send(a, roomId, number as number), 'invalid-argument');
  await rejectCode(send(outsider, roomId, 1, { uid: a.uid }), 'permission-denied');
  await rejectCode(send(a, roomId, 1, { revision: before.revision - 1 }), 'aborted');
  assert.deepEqual(await roomData(roomId), before);
});
