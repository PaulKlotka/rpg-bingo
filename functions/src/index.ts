import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';
import { command } from './service';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { cleanupExpiredRooms } from './cleanup';

initializeApp();
export const gameCommand = onCall({
  region: 'us-central1', maxInstances: 3, timeoutSeconds: 30,
  serviceAccount: process.env.FUNCTIONS_EMULATOR === 'true' ? undefined : 'bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com',
  enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== 'true',
}, request => command(getFirestore(), request.auth?.uid, request.data));

export const cleanupExpiredSessions = onSchedule({ schedule: 'every 60 minutes', timeZone: 'America/Chicago', maxInstances: 1, serviceAccount: process.env.FUNCTIONS_EMULATOR === 'true' ? undefined : 'bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com' }, async () => {
  await cleanupExpiredRooms(getFirestore());
});
