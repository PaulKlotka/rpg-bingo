import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { command } from './service';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { cleanupExpiredRooms } from './cleanup';
import { EmbeddedService } from './embedded-service';
import { RemoteGateway } from './integration-gateway';

initializeApp();
const embedded = () => new EmbeddedService(getFirestore(), new RemoteGateway());
// Public transport; authority comes only from the opaque connection credential
// bound server-side to a redeemed hub grant. It is not a Bingo Firebase login.
export const embeddedApi = onRequest({ region: 'us-central1', invoker: 'private', maxInstances: 3, timeoutSeconds: 60, cors: false,
  serviceAccount: process.env.FUNCTIONS_EMULATOR === 'true' ? undefined : 'bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com',
}, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: { code: 'invalid-argument', message: 'Use POST.' } }); return; }
  // Same-origin browser endpoint; the iframe, not the parent, sends these calls.
  const allowed = (process.env.BINGO_BROWSER_ORIGINS || 'https://rpg-bingo-paul.web.app').split(',').map(value => value.trim());
  if (req.get('Origin') && !allowed.includes(req.get('Origin')!)) { res.status(403).json({ error: { code: 'permission-denied', message: 'Invalid browser origin.' } }); return; }
  try {
    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 8192) throw new HttpsError('invalid-argument', 'Invalid request.');
    const service = embedded();
    let result: unknown;
    if (data.action === 'begin') result = await service.begin(data.nonce);
    else {
      const credential = req.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!credential) throw new HttpsError('unauthenticated', 'Connect through Between Turns.');
      result = data.action === 'connect' ? await service.connect(credential, data.nonce, data.grant) : await service.command(credential, data);
    }
    res.json({ result });
  } catch (error) {
    const known = error instanceof HttpsError;
    res.status(known ? (error.code === 'unauthenticated' ? 401 : 409) : 503).json({ error: {
      code: known ? error.code : 'unavailable', message: known ? error.message : 'Bingo could not reach Between Turns or Rewards. Retry to continue.',
    } });
  }
});

export const maintainEmbeddedGames = onSchedule({ schedule: 'every 1 minutes', maxInstances: 1, timeoutSeconds: 300,
  serviceAccount: process.env.FUNCTIONS_EMULATOR === 'true' ? undefined : 'bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com',
}, async () => { await embedded().maintain(); });
export const gameCommand = onCall({
  region: 'us-central1', maxInstances: 3, timeoutSeconds: 30,
  serviceAccount: process.env.FUNCTIONS_EMULATOR === 'true' ? undefined : 'bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com',
  enforceAppCheck: process.env.FUNCTIONS_EMULATOR !== 'true',
}, request => command(getFirestore(), request.auth?.uid, request.data));

export const cleanupExpiredSessions = onSchedule({ schedule: 'every 60 minutes', timeZone: 'America/Chicago', maxInstances: 1, serviceAccount: process.env.FUNCTIONS_EMULATOR === 'true' ? undefined : 'bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com' }, async () => {
  await cleanupExpiredRooms(getFirestore());
});
