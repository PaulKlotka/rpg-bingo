import { GameClients } from './service';
export function gameClients(emulator: boolean): GameClients {
  if (emulator) return {
    'rpg-bingo': { serviceAccount: 'bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com', redirectUris: ['http://127.0.0.1:5178/embed'] },
    'demo-game': { serviceAccount: 'demo-game@demo-rpg-rewards.iam.gserviceaccount.com', redirectUris: ['http://127.0.0.1:5174/callback'] },
    'other-game': { serviceAccount: 'other-game@demo-rpg-rewards.iam.gserviceaccount.com', redirectUris: ['http://127.0.0.1:5175/callback'] },
  };
  // No registered game identities is a safe default before production configuration.
  const raw = JSON.parse(process.env.GAME_CLIENTS_JSON || '{}') as GameClients;
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || !value.serviceAccount?.endsWith('.iam.gserviceaccount.com') || !Array.isArray(value.redirectUris) || !value.redirectUris.length) throw new Error('Invalid GAME_CLIENTS_JSON.');
    for (const uri of value.redirectUris) if (new URL(uri).protocol !== 'https:') throw new Error('Production callback URLs must use HTTPS.');
  }
  if (new Set(Object.values(raw).map(c => c.serviceAccount)).size !== Object.keys(raw).length) throw new Error('Each game requires a distinct service account.');
  return raw;
}
