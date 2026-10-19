import type { Firestore } from 'firebase-admin/firestore';

export async function cleanupExpiredRooms(db: Firestore, now = Date.now()): Promise<number> {
  const rooms = await db.collection('rooms').where('expiresAt', '<=', now).limit(20).get();
  let deleted = 0;
  for (const room of rooms.docs) {
    try { await db.recursiveDelete(room.ref); deleted++; }
    catch (error) {
      // Keep a discoverable tombstone if recursive deletion only partially succeeds.
      await room.ref.set({ ...room.data(), closed: true, expiresAt: now }, { merge: true });
      throw error;
    }
  }
  return deleted;
}
