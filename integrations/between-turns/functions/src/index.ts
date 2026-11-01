import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineString } from 'firebase-functions/params';
import { OAuth2Client } from 'google-auth-library';
import { GAMES, type Game, type GameCommand, type PlayerCommand, type Session } from '../../shared/types';
import { DomainError, assert } from './errors';
import { HubService, type RegisteredApp } from './service';
import { FirestoreStore } from './store';

initializeApp();
const region = 'us-central1';
const runtime = process.env.HUB_RUNTIME_SERVICE_ACCOUNT;
const emulator = process.env.FUNCTIONS_EMULATOR === 'true';
const registry = defineString('APPS_JSON', { default: '[]', description: 'Registered apps: id, kind, origin, serviceAccount. No private keys.' });
const catalog = defineString('GAMES_JSON', { default: '[]', description: 'Ready game overrides, including exact HTTPS embed URLs. Empty keeps Bingo as a placeholder.' });
const audience = defineString('GAME_API_AUDIENCE', { default: '', description: 'Exact deployed integrationApi URL.' });
type App = RegisteredApp & { serviceAccount: string };
function config(): { apps: App[]; games: Game[]; service: HubService } {
  const apps: App[] = JSON.parse(registry.value());
  const overrides: Game[] = JSON.parse(catalog.value());
  assert(Array.isArray(apps) && Array.isArray(overrides), 'failed-precondition', 'Invalid app configuration.');
  const httpsOrigin = (value: string) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; };
  assert(apps.every(a => /^[\w-]+$/.test(a.id) && ['game', 'rewards'].includes(a.kind) && httpsOrigin(a.origin) && new URL(a.origin).origin === a.origin && /^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(a.serviceAccount)) && new Set(apps.map(a => a.id)).size === apps.length && new Set(apps.map(a => a.serviceAccount)).size === apps.length, 'failed-precondition', 'Invalid application registry.');
  assert(apps.filter(a => a.kind === 'rewards').length <= 1 && apps.every(a => !a.embedUrl || (httpsOrigin(a.embedUrl) && new URL(a.embedUrl).origin === a.origin)), 'failed-precondition', 'Invalid rewards embed configuration.');
  const games = overrides.length ? overrides : GAMES;
  assert(games.every(g => /^[\w-]+$/.test(g.id) && typeof g.name === 'string' && typeof g.description === 'string' && typeof g.ready === 'boolean' && (!g.ready || (g.embedUrl && httpsOrigin(g.embedUrl) && apps.some(a => a.id === g.id && a.kind === 'game' && a.origin === new URL(g.embedUrl!).origin)))) && new Set(games.map(g => g.id)).size === games.length, 'failed-precondition', 'Invalid game catalog.');
  return { apps, games, service: new HubService(new FirestoreStore(), games, apps) };
}
export const playerCommand = onCall({ region, invoker: 'private', ...(runtime ? { serviceAccount: runtime } : {}), enforceAppCheck: !emulator, maxInstances: 10, timeoutSeconds: 30 }, async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Connect your guest identity first.');
  try {
    assert(JSON.stringify(req.data).length <= 8192, 'invalid-argument', 'Request is too large.');
    return await config().service.player(req.auth.uid, req.data as PlayerCommand);
  } catch (error) {
    if (error instanceof DomainError) throw new HttpsError(error.code, error.message);
    console.error('Player command failed', error instanceof Error ? error.name : 'Unknown');
    throw new HttpsError('internal', 'The session could not be updated. Please try again.');
  }
});

const verifier = new OAuth2Client();
export const integrationApi = onRequest({ region, ...(runtime ? { serviceAccount: runtime } : {}), invoker: 'private', maxInstances: 10, timeoutSeconds: 30, cors: false }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: { code: 'invalid-argument', message: 'Use POST.' } }); return; }
  try {
    const { apps, service } = config();
    assert(JSON.stringify(req.body).length <= 8192, 'invalid-argument', 'Request is too large.');
    let app: App | undefined;
    if (emulator) app = apps.find(a => a.id === req.header('X-Emulator-App'));
    else {
      const token = req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1];
      assert(token && audience.value(), 'unauthenticated', 'Backend authentication is required.');
      const ticket = await verifier.verifyIdToken({ idToken: token, audience: audience.value() });
      const identity = ticket.getPayload();
      assert(identity?.email_verified && ['accounts.google.com', 'https://accounts.google.com'].includes(identity.iss), 'unauthenticated', 'Invalid backend identity.');
      app = apps.find(a => a.serviceAccount === identity.email);
    }
    assert(app, 'permission-denied', 'This backend is not registered.');
    res.json({ result: await service.game(app.id, req.body as GameCommand) });
  } catch (error) {
    const domain = error instanceof DomainError;
    const code = domain ? error.code : 'unauthenticated';
    const status = { 'invalid-argument': 400, unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, 'failed-precondition': 409, 'resource-exhausted': 429 }[code];
    res.status(status).json({ error: { code, message: domain ? error.message : 'Backend request could not be authenticated.' } });
  }
});

export async function maintain() {
  const db = getFirestore(); const now = Date.now(); const { service } = config();
  const voting = await db.collection('sessions').where('phase', '==', 'voting').limit(100).get();
  for (const doc of voting.docs) await service.settleSession(doc.id);
  const expired = await db.collection('sessions').where('expiresAt', '<=', now).limit(100).get();
  for (const doc of expired.docs) {
    await db.runTransaction(async tx => {
      const fresh = await tx.get(doc.ref); const s = fresh.data() as Session | undefined;
      if (!s || s.expiresAt > now) return;
      const members = await Promise.all(Object.keys(s.members).map(uid => tx.get(db.doc(`players/${uid}`))));
      const codeRef = db.doc(`codes/${s.code}`); const code = await tx.get(codeRef);
      for (const member of members) if (member.data()?.sessionId === s.id) tx.delete(member.ref);
      if (code.data()?.sessionId === s.id) tx.delete(codeRef);
      tx.delete(doc.ref);
    });
  }
  for (const collection of ['grants', 'receipts']) {
    const old = await db.collection(collection).where('expiresAt', '<=', now).limit(300).get();
    if (old.empty) continue;
    const batch = db.batch(); old.docs.forEach(doc => batch.delete(doc.ref)); await batch.commit();
  }
}
export const sessionMaintenance = onSchedule({ region, ...(runtime ? { serviceAccount: runtime } : {}), schedule: 'every 1 minutes', maxInstances: 1, timeoutSeconds: 120 }, maintain);
