import { initializeApp } from 'firebase/app';
import { browserLocalPersistence, connectAuthEmulator, getAuth, setPersistence, signInAnonymously } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import type { PlayerCommand, PlayerResponse } from '../shared/types';
const env = import.meta.env;
export const local = env.VITE_USE_FIREBASE_EMULATORS === 'true' || (import.meta.env.DEV && !env.VITE_FIREBASE_PROJECT_ID);
const projectId = env.VITE_FIREBASE_PROJECT_ID || 'demo-between-turns';
if (!local && (!env.VITE_FIREBASE_PROJECT_ID || !env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_APP_ID || !env.VITE_APPCHECK_SITE_KEY)) throw new Error('Production Firebase and App Check configuration is missing.');
const app = initializeApp({ projectId, apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key', authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`, appId: env.VITE_FIREBASE_APP_ID || 'demo-app' });
const auth = getAuth(app); const functions = getFunctions(app, 'us-central1');
if (local) { connectAuthEmulator(auth, 'http://127.0.0.1:9299', { disableWarnings: true }); connectFunctionsEmulator(functions, '127.0.0.1', 5201); }
else initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(env.VITE_APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
export async function initialize() {
  await setPersistence(auth, browserLocalPersistence); await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
}
const invoke = httpsCallable<PlayerCommand, PlayerResponse>(functions, 'playerCommand');
export async function command(value: PlayerCommand) { return (await invoke(value)).data; }
