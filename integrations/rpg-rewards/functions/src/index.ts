import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineString } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { OAuth2Client } from 'google-auth-library';
import { RewardsService, fail } from './service';
import { gameClients } from './config';
import { CentralRewards } from './central-service';
import { RemoteHub } from './hub-gateway';

initializeApp();
const emulator = process.env.FUNCTIONS_EMULATOR === 'true';
setGlobalOptions({ serviceAccount: emulator ? undefined : defineString('REWARDS_RUNTIME_SERVICE_ACCOUNT') });
const clients = gameClients(emulator);
const service = new RewardsService(getFirestore(), clients);
const verifier = new OAuth2Client();
const central = () => new CentralRewards(getFirestore(), new RemoteHub());

export const embeddedApi = onRequest({ region: 'us-central1', invoker: 'private', maxInstances: 5, timeoutSeconds: 60, cors: false }, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (request.method !== 'POST') { response.status(405).json({ error: { code: 'invalid-argument', message: 'Use POST.' } }); return; }
  const allowed = (process.env.REWARDS_BROWSER_ORIGINS || 'https://rpg-rewards-paul.web.app').split(',').map(s => s.trim());
  if (request.get('Origin') && !allowed.includes(request.get('Origin')!)) { response.status(403).json({ error: { code: 'permission-denied', message: 'Invalid browser origin.' } }); return; }
  try {
    const data = request.body;
    if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 8192) throw new HttpsError('invalid-argument', 'Invalid request.');
    const adapter = central(); let result: unknown;
    if (data.action === 'begin') result = await adapter.begin(data.nonce);
    else {
      const credential = request.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!credential) throw new HttpsError('unauthenticated', 'Open Rewards through Between Turns.');
      result = data.action === 'connect' ? await adapter.connect(credential, data.nonce, data.grant) : await adapter.player(credential, data);
    }
    response.json({ result });
  } catch (error) {
    const known = error instanceof HttpsError;
    response.status(known ? 409 : 503).json({ error: { code: known ? error.code : 'unavailable', message: known ? error.message : 'Rewards could not reach Between Turns. Retry to continue.' } });
  }
});

export const maintainCentralRewards = onSchedule({ schedule: 'every 1 minutes', region: 'us-central1', maxInstances: 1, timeoutSeconds: 120 }, async () => { await central().maintain(); });

// Deployment configures public HTTP invocation separately for domain-restricted organizations.
// Firebase Authentication and App Check remain enforced by this callable.
export const playerCommand = onCall({ region: 'us-central1', invoker: 'private', enforceAppCheck: !emulator, maxInstances: 5 }, request => service.player(request.auth?.uid, request.data));

export const gameApi = onRequest({ region: 'us-central1', cors: false, invoker: 'private', maxInstances: 5, timeoutSeconds: 30 }, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  if (request.method !== 'POST') { response.status(405).json({ error: 'POST required.' }); return; }
  try {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || JSON.stringify(request.body).length > 8192) return fail('invalid-argument', 'Invalid request.');
    let gameId: string | undefined;
    if (emulator) {
      // Loopback emulator only. This branch does not exist in deployed function behavior.
      const localIdentity = request.get('X-Emulator-Game');
      if (localIdentity && clients[localIdentity]) gameId = localIdentity;
    } else {
      const audience = process.env.GAME_API_AUDIENCE;
      if (!audience) return fail('failed-precondition', 'Game API audience is not configured.');
      const authorization = request.get('Authorization') || '';
      if (!authorization.startsWith('Bearer ')) return fail('unauthenticated', 'A game service-account ID token is required.');
      let payload;
      try { payload = (await verifier.verifyIdToken({ idToken: authorization.slice(7), audience })).getPayload(); }
      catch { return fail('unauthenticated', 'Invalid game service-account ID token.'); }
      if (payload?.email_verified && payload.email && ['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) gameId = Object.entries(clients).find(([, c]) => c.serviceAccount === payload.email)?.[0];
    }
    if (!gameId) return fail('permission-denied', 'Game backend is not authorized.');
    const result = request.body.runId ? await central().game(gameId, request.body) : await service.game(gameId, request.body);
    response.json({ result });
  } catch (error) {
    const known = error instanceof HttpsError;
    const code = known ? error.code : 'internal';
    const status = ({ 'invalid-argument': 400, 'unauthenticated': 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, 'failed-precondition': 409 } as Record<string, number>)[code] || 500;
    if (!known) console.error('Game API failure', error);
    response.status(status).json({ error: { code, message: known ? error.message : 'Internal server error.' } });
  }
});

export const cleanupExpiredSessions = onSchedule({ schedule: 'every 60 minutes', region: 'us-central1', maxInstances: 1 }, async () => { await service.cleanup(); });
