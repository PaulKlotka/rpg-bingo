import { initializeApp } from 'firebase/app';
import { initializeAuth, browserLocalPersistence, connectAuthEmulator, onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import type { Session, SessionView } from '../shared/model';

const env = import.meta.env;
export const local = env.VITE_USE_FIREBASE_EMULATORS === 'true' || (env.DEV && !env.VITE_FIREBASE_PROJECT_ID);
export const configured = local || Boolean(env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_APP_ID && env.VITE_FIREBASE_APPCHECK_SITE_KEY);
const app = configured ? initializeApp({
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-rpg-rewards',
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'demo-rpg-rewards.firebaseapp.com',
  appId: env.VITE_FIREBASE_APP_ID || 'demo-app',
}) : undefined;
const auth = app ? initializeAuth(app, { persistence: browserLocalPersistence }) : undefined;
const functions = app ? getFunctions(app, 'us-central1') : undefined;
if (app && !local && env.VITE_FIREBASE_APPCHECK_SITE_KEY) initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(env.VITE_FIREBASE_APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
if (local && auth && functions) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true });
  connectFunctionsEmulator(functions, '127.0.0.1', 5101);
}
export async function identity(): Promise<string> {
  if (!auth) throw new Error('Firebase configuration is required. See README.md for setup.');
  await new Promise<void>((resolve, reject) => { const unsubscribe = onAuthStateChanged(auth, () => { unsubscribe(); resolve(); }, reject); });
  return (auth.currentUser || (await signInAnonymously(auth)).user).uid;
}
export async function command<T>(data: Record<string, unknown>): Promise<T> {
  if (!functions) throw new Error('Firebase is not configured.');
  return (await httpsCallable<Record<string, unknown>, T>(functions, 'playerCommand')(data)).data;
}
export const listSessions = () => command<Session[]>({ action: 'list' });
export const viewSession = (sessionId: string) => command<SessionView>({ action: 'view', sessionId });
