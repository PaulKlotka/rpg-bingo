# Firebase deployment

Dedicated project: `between-turns-paul` (Between Turns). The intended default Hosting URL is https://between-turns-paul.web.app. This project is separate from RPG Bingo and RPG Rewards. Always pass the project ID explicitly; do not deploy to either existing project.

## Current deployment status — October 31, 2026

Live sessions are deployed at https://between-turns-paul.web.app. Billing is enabled. Firestore in us-central1, Anonymous Authentication, App Check, the three Node 22 functions, and the minute maintenance schedule are configured. The production frontend has preview mode disabled. Bingo and Rewards remain integration placeholders; the app registry and ready-game overrides are empty.

The runtime uses the dedicated between-turns-runtime service account. Only the player callable has public HTTP transport; Firebase Authentication and App Check are still enforced. Integration API and maintenance invocation remain IAM protected. A seven-day artifact cleanup policy is enabled.

Google initially blocked billing activation with a billing-project quota error. After the user deleted unused projects, billing linkage succeeded and provisioning completed. Existing game projects were not changed.

Verified on the deployed HTTPS origin with two independent guest browsers: create/join, duplicate-name rejection, roster synchronization, refresh persistence, QR invitations, navigation, rewards placeholder, 320/390-pixel layouts, and leaving. Missing guest/App Check credentials return HTTP 401; the private integration API returns HTTP 403 without backend authentication. The maintenance schedule is ENABLED.

## Configuration

1. Enable billing, Firestore Native mode in `us-central1`, Anonymous Authentication, Hosting, Functions, Cloud Scheduler, Artifact Registry, and reCAPTCHA Enterprise/App Check.
2. Register a web app. Allow `between-turns-paul.web.app` and `between-turns-paul.firebaseapp.com` in Auth and the reCAPTCHA Enterprise score key's domain list.
3. Register that key for the web app in Firebase App Check. The production callable enforces App Check; development bypass exists only when the Functions emulator sets `FUNCTIONS_EMULATOR=true`.
4. Use a dedicated `between-turns-runtime` service account with `roles/datastore.user` and `roles/firebaseappcheck.tokenVerifier`; set `HUB_RUNTIME_SERVICE_ACCOUNT` in the functions environment before deploying. Keep database access out of the registered game identities. The build account needs the standard Functions/Cloud Build build permissions.
5. Set ignored `.env.production.local` with public Firebase config and `VITE_APPCHECK_SITE_KEY`; set `VITE_USE_FIREBASE_EMULATORS=false`. Never put service-account keys or private credentials in Vite values.
6. Set ignored `functions/.env.between-turns-paul` with `APPS_JSON=[]`, `GAMES_JSON=[]`, and the exact `GAME_API_AUDIENCE`. Empty registries retain placeholders and reject all external integrations.

```sh
npm ci
npm --prefix functions ci
npm test
npm run verify:emulators
npm run build
npm run firebase -- deploy --only firestore:rules,firestore:indexes,functions --project between-turns-paul --non-interactive
node --use-system-ca scripts/configure-player-endpoint.cjs
npm run firebase -- deploy --only hosting --project between-turns-paul --non-interactive
```

Run configure-player-endpoint.cjs after every function deployment. The Firebase CLI may report that it could not set the callable's public IAM policy under the organization's sharing restriction even when the function is ACTIVE. Verify function status before proceeding, then use this scoped service-level configuration; do not change the organization policy or expose the private backend.

The browser callable is publicly invokable at the transport level and enforces Firebase Authentication and App Check in its handler. Keep `integrationApi` private. Its registered callers require exact Cloud Run invocation grants. Never make the integration API publicly invokable to fix an authorization error.

The scheduled job runs every minute, settles overdue votes, and deletes up to 100 expired session aggregates and their matching membership pointers/codes, plus expired handoff grants and event receipts. Client operations check expiry immediately. Direct browser reads and writes are denied by Firestore rules.

## Acceptance checks

- Anonymous identity survives reload on the deployed origin.
- Two browsers can create/join the same session and see matching rosters.
- Duplicate names are rejected; QR codes decode to the actual HTTPS invitation.
- All views fit 320-pixel phones; navigation preserves active embedded apps when integrations are enabled.
- Guest requests without Authentication or App Check are rejected.
- The integration API rejects unregistered callers and remains private.
- Runtime and build accounts have the required scoped permissions; the maintenance job is enabled.
- Both integrations remain placeholders with an empty registry. Do not enable them until their separate app updates pass the contract tests.

No production test adapter, demo-win endpoint, or seeded test game is included. Local automated tests supply fake game catalogs directly to the backend service.
