import { completedPatterns, selectPattern } from './shared/patterns';
import { expired, nextExpiry } from './shared/lifetime';
import { randomInt } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { newGame } from './shared/game';
import { PRIZES } from './shared/prizes';
import type { Player, Room, RollReceipt, RoundResult } from './shared/multiplayer';

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const dieNumber = (value: unknown): value is number => integer(value) && value >= 1 && value <= 20;
const random = () => randomInt(0, 2 ** 32) / 2 ** 32;
const card = () => [...newGame(random, random).card];
const prize = () => PRIZES[randomInt(PRIZES.length)].name;
const bingo = (numbers: Player['card'], marks: number[], pattern?: string) => numbers !== null && completedPatterns(pattern, i => numbers[i] === null || marks.includes(numbers[i]!)).length > 0;
function requireLive(room: Room) {
  if (expired(room.expiresAt)) throw new HttpsError('failed-precondition', 'This session expired after 24 hours without activity. Leave the room to play solo or create a new invite.');
}

// Only this trusted service writes multiplayer state. Never accept a player ID from input.
export async function command(db: Firestore, uid: string | undefined, input: unknown): Promise<unknown> {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in anonymously before joining a game.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpsError('invalid-argument', 'Invalid request.');
  const data = input as Record<string, unknown>;
  if (!identifier(data.roomId)) throw new HttpsError('invalid-argument', 'Invalid session link.');
  const roomRef = db.doc(`rooms/${data.roomId}`);
  const playerRef = roomRef.collection('players').doc(uid);

  // Invite holders may check availability without reading private room/player data.
  // This is read-only: reopening a page must never extend the session lifetime.
  if (data.action === 'status') {
    const snapshot = await roomRef.get();
    const room = snapshot.data() as Room | undefined;
    return { available: !!room && !room.closed && !expired(room.expiresAt), expiresAt: room?.expiresAt ?? null };
  }

  if (data.action === 'create' || data.action === 'join') {
    if (typeof data.name !== 'string' || data.name.trim().length < 1 || data.name.trim().length > 32 || /[\x00-\x1f\x7f]/.test(data.name)) throw new HttpsError('invalid-argument', 'Enter a display name of 1–32 characters.');
    const name = data.name.trim();
    return db.runTransaction(async tx => {
      const roomSnapshot = await tx.get(roomRef);
      const playerSnapshot = await tx.get(playerRef);
      if (data.action === 'create') {
        if (roomSnapshot.exists) {
          if (roomSnapshot.get('creator') === uid) return { roomId: data.roomId };
          throw new HttpsError('already-exists', 'That session already exists.');
        }
        const startImmediately = data.startImmediately === true;
        const room: Room = {
          phase: startImmediately ? 'shared' : 'inviting', creator: uid, round: startImmediately ? 1 : 0, revision: 0, rolls: 0, marks: [], prize: startImmediately ? prize() : '', expiresAt: nextExpiry(),
          ...(startImmediately ? { pattern: selectPattern(random) } : {}),
          members: [{ uid, name, eligibleRound: 1 }], lastSubmitter: null, lastAction: null, lastResult: null,
        };
        tx.create(roomRef, room);
        tx.create(playerRef, { name, card: startImmediately ? card() : null, eligibleRound: 1 } satisfies Player);
      } else {
        if (!roomSnapshot.exists) throw new HttpsError('not-found', 'Session not found. Check the link.');
        const room = roomSnapshot.data() as Room;
        requireLive(room);
        if (room.closed) throw new HttpsError('failed-precondition', 'Everyone has left this session. Start a new invite from solo play.');
        const joinCurrent = room.phase === 'shared' && room.marks.length === 0 && !room.pendingBingo;
        if (playerSnapshot.exists && !playerSnapshot.get('left')) {
          if (joinCurrent && playerSnapshot.get('eligibleRound') > room.round) {
            tx.update(playerRef, { card: card(), eligibleRound: room.round });
            tx.update(roomRef, { members: room.members.map(member => member.uid === uid ? { ...member, eligibleRound: room.round } : member), revision: room.revision + 1, expiresAt: nextExpiry() });
          }
          return { roomId: data.roomId };
        }
        // Bound transaction size; even a tied win stays below Firestore write limits.
        if (room.members.length >= 100) throw new HttpsError('resource-exhausted', 'This session is full (100 players).');
        const eligibleRound = joinCurrent ? room.round : room.round + 1;
        tx.set(playerRef, { name, eligibleRound, card: joinCurrent ? card() : null, left: false } satisfies Player);
        tx.update(roomRef, { members: [...room.members, { uid, name, eligibleRound }], revision: room.revision + 1, expiresAt: nextExpiry() });
      }
      return { roomId: data.roomId };
    });
  }

  if (data.action === 'leave') {
    return db.runTransaction(async tx => {
      const roomSnapshot = await tx.get(roomRef);
      const player = await tx.get(playerRef);
      if (!roomSnapshot.exists || !player.exists || player.get('left')) return { left: true };
      const room = roomSnapshot.data() as Room;
      const members = room.members.filter(member => member.uid !== uid);
      tx.update(playerRef, { left: true, card: null });
      tx.update(roomRef, {
        members, revision: room.revision + 1, closed: members.length === 0,
        creator: room.creator === uid && members.length ? members[0].uid : room.creator,
      });
      return { left: true };
    });
  }

  if (data.action === 'start') {
    return db.runTransaction(async tx => {
      const roomSnapshot = await tx.get(roomRef);
      if (!roomSnapshot.exists) throw new HttpsError('not-found', 'Session not found.');
      const room = roomSnapshot.data() as Room;
      if (room.creator !== uid) throw new HttpsError('permission-denied', 'Only the host can start the first shared card.');
      requireLive(room);
      if (room.phase === 'shared') return { round: room.round };
      if (room.members.length < 2) throw new HttpsError('failed-precondition', 'Keep playing solo until another player joins.');
      const players = await tx.get(roomRef.collection('players'));
      for (const player of players.docs.filter(p => !p.get('left'))) tx.update(player.ref, { card: card(), eligibleRound: 1 });
      tx.update(roomRef, {
        phase: 'shared', round: 1, revision: room.revision + 1, prize: prize(), pattern: selectPattern(random), expiresAt: nextExpiry(),
        members: room.members.map(member => ({ ...member, eligibleRound: 1 })),
      });
      return { round: 1 };
    });
  }

  if (data.action === 'use') {
    if (!integer(data.awardRound) || data.awardRound < 1 || typeof data.used !== 'boolean') throw new HttpsError('invalid-argument', 'Invalid prize update.');
    const awardRef = playerRef.collection('awards').doc(String(data.awardRound));
    return db.runTransaction(async tx => {
      const room = await tx.get(roomRef);
      const player = await tx.get(playerRef);
      const award = await tx.get(awardRef);
      if (!player.exists || !award.exists) throw new HttpsError('permission-denied', 'That prize does not belong to you.');
      if (!room.exists) throw new HttpsError('not-found', 'Session not found.');
      requireLive(room.data() as Room);
      tx.update(awardRef, { used: data.used });
      tx.update(roomRef, { expiresAt: nextExpiry() });
      return { used: data.used };
    });
  }

  if (data.action === 'undo') {
    if (!identifier(data.requestId) || !identifier(data.rollRequestId) || !integer(data.round) || data.round < 1 || !integer(data.revision)) throw new HttpsError('invalid-argument', 'Invalid undo request.');
    const receiptRef = roomRef.collection('commands').doc(`${uid}_${data.requestId}`);
    const fingerprint = JSON.stringify(['undo', data.round, data.revision, data.rollRequestId]);
    return db.runTransaction(async tx => {
      const previous = await tx.get(receiptRef);
      if (previous.exists) {
        if (previous.get('fingerprint') !== fingerprint) throw new HttpsError('invalid-argument', 'Request ID was already used for a different action.');
        return previous.get('receipt');
      }
      const snapshot = await tx.get(roomRef);
      if (!snapshot.exists) throw new HttpsError('not-found', 'Session not found.');
      const room = snapshot.data() as Room;
      requireLive(room);
      if (room.pendingBingo && Date.now() >= room.pendingBingo.confirmAt) throw new HttpsError('failed-precondition', 'The bingo review period has ended.');
      const actor = room.members.find(member => member.uid === uid);
      if (!actor) throw new HttpsError('permission-denied', 'Join this session before undoing a roll.');
      const undo = room.undo;
      if (room.phase !== 'shared' || actor.eligibleRound > room.round || !undo || undo.uid !== uid || room.lastSubmitter !== uid || undo.round !== room.round || undo.requestId !== data.rollRequestId) throw new HttpsError('failed-precondition', 'Only your latest roll can be undone, before another player submits or the round ends.');
      if (room.round !== data.round || room.revision !== data.revision) throw new HttpsError('aborted', 'The game changed. Check the latest state before undoing.');
      const waiting = undo.marks.length === 0 ? room.members.filter(member => member.eligibleRound > room.round) : [];
      const waitingPlayers = await Promise.all(waiting.map(member => tx.get(roomRef.collection('players').doc(member.uid))));
      const receipt = { undone: true, round: room.round, revision: room.revision + 1 };
      for (const waitingPlayer of waitingPlayers) {
        if (waitingPlayer.exists && !waitingPlayer.get('left')) tx.update(waitingPlayer.ref, { card: card(), eligibleRound: room.round });
      }
      tx.update(roomRef, {
        marks: undo.marks, rolls: undo.rolls, lastSubmitter: undo.lastSubmitter,
        members: room.members.map(member => waiting.some(waiter => waiter.uid === member.uid) ? { ...member, eligibleRound: room.round } : member),
        lastAction: undo.lastAction, undo: null, pendingBingo: null, lastUndo: { name: actor.name, number: undo.number, round: room.round },
        revision: receipt.revision, expiresAt: nextExpiry(),
      });
      tx.create(receiptRef, { fingerprint, receipt });
      return receipt;
    });
  }

  if (data.action === 'confirm') {
    if (!integer(data.round) || data.round < 1 || !identifier(data.pendingId)) throw new HttpsError('invalid-argument', 'Invalid bingo confirmation.');
    const confirmingRound = data.round;
    return db.runTransaction(async tx => {
      const snapshot = await tx.get(roomRef);
      if (!snapshot.exists) throw new HttpsError('not-found', 'Session not found.');
      const room = snapshot.data() as Room;
      requireLive(room);
      if (!room.members.some(member => member.uid === uid)) throw new HttpsError('permission-denied', 'Join this session before confirming bingo.');
      if (room.round > confirmingRound) return { confirmed: true, round: room.round };
      const pending = room.pendingBingo;
      if (!pending || room.round !== data.round || pending.requestId !== data.pendingId) throw new HttpsError('failed-precondition', 'That bingo is no longer pending.');
      if (Date.now() < pending.confirmAt) throw new HttpsError('failed-precondition', 'Allow fifteen seconds to review the winning roll.');
      const players = await tx.get(roomRef.collection('players'));
      const nextRound = room.round + 1;
      for (const winner of pending.result.winners) tx.create(roomRef.collection('players').doc(winner.uid).collection('awards').doc(String(room.round)), {
        id: String(room.round), round: room.round, prize: pending.result.prize, used: false,
      });
      for (const player of players.docs.filter(p => !p.get('left'))) tx.update(player.ref, { card: card(), eligibleRound: nextRound });
      tx.create(roomRef.collection('rounds').doc(String(room.round)), pending.result);
      tx.update(roomRef, {
        round: nextRound, revision: room.revision + 1, marks: [], rolls: 0, prize: prize(), pattern: selectPattern(random),
        expiresAt: nextExpiry(), lastResult: pending.result, pendingBingo: null, undo: null, lastUndo: null,
        members: room.members.map(member => ({ ...member, eligibleRound: nextRound })),
      });
      return { confirmed: true, round: nextRound };
    });
  }

  if (data.action !== 'roll' || !identifier(data.requestId) || !integer(data.round) || data.round < 1 || !integer(data.revision) || (data.kind !== 'physical' && data.kind !== 'virtual') || (data.kind === 'physical' && !dieNumber(data.number))) throw new HttpsError('invalid-argument', 'Enter a whole number from 1 to 20.');
  const kind = data.kind;
  const submittedNumber = data.number;
  const commandRef = roomRef.collection('commands').doc(`${uid}_${data.requestId}`);
  const fingerprint = JSON.stringify([data.round, data.revision, kind, kind === 'physical' ? submittedNumber : null]);
  return db.runTransaction(async tx => {
    const previous = await tx.get(commandRef);
    if (previous.exists) {
      if (previous.get('fingerprint') !== fingerprint) throw new HttpsError('invalid-argument', 'Request ID was already used for a different roll.');
      return previous.get('receipt') as RollReceipt;
    }
    const roomSnapshot = await tx.get(roomRef);
    if (!roomSnapshot.exists) throw new HttpsError('not-found', 'Session not found.');
    const room = roomSnapshot.data() as Room;
    requireLive(room);
    if (room.phase !== 'shared') throw new HttpsError('failed-precondition', 'The host is finishing their single-player card.');
    const actor = room.members.find(member => member.uid === uid);
    if (!actor) throw new HttpsError('permission-denied', 'Join this session before submitting a roll.');
    if (actor.eligibleRound > room.round) throw new HttpsError('failed-precondition', 'You are waiting for the next round.');
    if (room.pendingBingo) throw new HttpsError('failed-precondition', 'Cards are locked while bingo is reviewed.');
    if (room.members.filter(member => member.eligibleRound <= room.round).length < 2) throw new HttpsError('failed-precondition', 'Shared play needs two active players. You can leave the room to play solo or create a new invite.');
    if (room.lastSubmitter === uid) throw new HttpsError('failed-precondition', 'A different active player must submit the next roll.');
    if (room.round !== data.round || room.revision !== data.revision) throw new HttpsError('aborted', 'The game changed. Check the latest result before submitting again.');
    const players = await tx.get(roomRef.collection('players'));
    const value = kind === 'virtual' ? randomInt(1, 21) : submittedNumber as number;
    const marks = [...new Set([...room.marks, value])];
    const winners = players.docs.filter(player => {
      const p = player.data() as Player;
      return !p.left && p.eligibleRound <= room.round && bingo(p.card, marks, room.pattern);
    }).map(player => ({ uid: player.id, name: player.get('name') as string }));
    const revision = room.revision + 1;
    const lastAction = { number: value, name: actor.name, round: room.round };
    const resultingRound = room.round;
    tx.update(roomRef, {
        revision, marks, rolls: room.rolls + 1, lastSubmitter: uid, lastAction, expiresAt: nextExpiry(), lastUndo: null,
        undo: { uid, requestId: data.requestId, number: value, round: room.round, marks: room.marks, rolls: room.rolls, lastSubmitter: room.lastSubmitter, lastAction: room.lastAction },
        pendingBingo: winners.length ? { result: { round: room.round, number: value, prize: room.prize, pattern: room.pattern ?? 'single-line', winners } satisfies RoundResult, confirmAt: Date.now() + 15000, requestId: data.requestId } : null,
      });
    const receipt: RollReceipt = { number: value, playedRound: room.round, resultingRound, revision };
    tx.create(commandRef, { fingerprint, receipt });
    return receipt;
  });
}
