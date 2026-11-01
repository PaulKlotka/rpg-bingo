# Future Firebase deployment

This is a preparation guide, not a record of a deployment. No Firebase project has been provisioned. Do not reuse the RPG Bingo project or its service accounts, credentials or project aliases.

## New project configuration

1. Create a dedicated Firebase project when deployment is authorized. Enable billing as needed for Cloud Functions and Cloud Scheduler, register a web app, and create Firestore in Native mode. The functions are configured for `us-central1`; choose the database location deliberately before creation.
2. Enable Anonymous Authentication in the new project. This becomes the central identity authority for future games. Register the Rewards hosting domain in authorized domains.
3. Register the Rewards web app for reCAPTCHA Enterprise App Check and allow its exact domain. Set up quotas and billing appropriate to expected usage.
4. Copy `.env.example` to an ignored `.env.production.local`. Set `VITE_USE_FIREBASE_EMULATORS=false`, replace every demo Firebase value with the new project's public config, and set `VITE_FIREBASE_APPCHECK_SITE_KEY`. The production UI refuses to initialize without the necessary config. These Vite values are public configuration, never service-account credentials.
5. Copy `functions/.env.example` to the appropriate ignored `functions/.env.PROJECT_ID`. Set `GAME_API_AUDIENCE` to the exact gameApi function URL and configure `GAME_CLIENTS_JSON` with distinct registered game runtime service-account emails and exact HTTPS callback URLs. With no registered clients, the backend game API fails closed. Do not register the local demo game in production.
6. Use an appropriate dedicated function runtime service account with Firestore access and no project-wide owner/editor access. Configure its service account in the function options before deployment if the project default is broader than intended. The cleanup function also needs permission to delete the Rewards documents. Games need invocation access to gameApi, not direct access to the Rewards database.

## Validate and deploy when authorized

```sh
npm ci
npm --prefix functions ci
npm test
npm run verify:emulators
npm run build
# Only after separately authorizing creation/configuration/deployment:
npx firebase deploy --only firestore:rules,firestore:indexes,functions,hosting --project YOUR_NEW_PROJECT_ID
```

No `.firebaserc` alias is committed; always supply an explicit new project ID. Check the production build contains no demo project identifiers or loopback endpoints in its active configuration. Source code necessarily includes emulator branches, but production selection must be false. Never deploy `demo/game-server.ts`.

gameApi is deployed private. Grant `roles/run.invoker` on its Cloud Run service to the registered game service accounts. Set their runtime permissions to obtain ID tokens as themselves. Match the configured audience to the exact endpoint they call. Keep the player callable accessible through the Firebase SDK; its own handler enforces Authentication and App Check. Verify allowed and rejected calls after deployment.

## Cloud acceptance checks

- Verify guest creation and reload persistence on the actual hosting origin, including App Check enforcement.
- Verify shared joining and owner-only consume/undo with separate devices.
- Verify a real registered backend OIDC caller can draw and award, and a browser guest token or unregistered service account cannot.
- Verify cross-origin handoff with an HTTPS allowlisted callback and game-side state validation.
- Verify hourly cleanup is scheduled and expiry blocks use before deletion.
- Verify billing alerts, runtime IAM and quotas. Watch session-member and history sizes; the first release reads the current session's entire award history rather than paginating it.
- A real-game integration, existing-session migration, and account-linking UI are separate work. No changes to RPG Bingo are part of this repository.

Local emulators cannot validate cloud IAM, real OIDC caller permissions, reCAPTCHA Enterprise, billing, deployed domain behavior or the live scheduler. Those checks remain necessary when deployment is authorized.
