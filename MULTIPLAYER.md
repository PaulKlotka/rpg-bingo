# Shared bingo: local setup and deployment

## Current scope

The default page stays single-player. **Invite a player · Show QR / session link** opens an invitation; a display name creates an anonymous session. The QR encodes a direct URL to that exact session. No room code or signup is required.

Inviting preserves the host's current local card, marks, prize, win lock, and solo inventory. Every invited player waits without a card. The host continues unrestricted single-player play for the current card. Once someone has joined, the host's next explicit **New Card** starts the first shared round and deals fresh cards and one new shared prize to everyone. Inviting alone does not reset a card or force the host into a lobby.

In shared play:

1. Each active player has a separately randomized 5×5 card, free center, every number from 1–20, and four distinct numbers appearing twice.
2. Any eligible active player can tap a numbered card square to submit a physical result, or roll the virtual die for the group. Tapping a square submits that number as a shared roll; it does not toggle marks off. Shared rolls only add marks. The free center cannot be submitted.
3. The same player cannot submit twice consecutively, across either input method and across round boundaries. This is not a fixed order: any different active player may submit next. Waiting players cannot submit. The server enforces this rule; rejected requests do not mutate the round or prizes.
4. A bingo locks every card for a fifteen-second review. The winning submitter can undo during that window; no prizes or fresh cards are issued yet. At the server deadline, connected clients automatically request confirmation. One transaction awards tied winners, deals fresh cards, clears marks, admits waiters, and selects the next pattern/prize. If everyone disconnects, the first member reconnecting completes overdue confirmation.
5. A persistent latest-round banner identifies the winners, winning number and prize, so the automatic reset does not hide the result. The banner remains until another round completes.
6. Later joiners receive a fresh active card immediately if the shared round has no marked numbers and no pending bingo. Otherwise they wait until the next round. The initial invite phase still waits for the host to start shared play. Joining races the first roll in one server transaction, preventing a partially played deal.
7. Shared prizes have reversible used/unused controls and persist under the player's anonymous identity. Solo prizes remain separate and accessible below, with their original browser saving and controls. No prizes are imported from a client's untrusted solo save into the server's earned-prize ledger.

Sessions expire after 24 hours without accepted activity, with hourly recursive cleanup in the cloud. Leave room returns to solo at any time and transfers the host role when needed. Shared rolls require at least two active players. There is no fixed player order or account recovery flow. A session has a technical limit of 100 participants to bound Firestore transaction writes.

## Run locally without a Firebase project or billing

Prerequisites: Node.js 22.12+ (the function deployment targets Node 22), npm, and Java 21+. On this computer an existing Android Studio Java 21 runtime is detected automatically by the helper; otherwise put Java on PATH. Local tests here used Node 24.21 and Java 21.0.9, so they are not a cloud Node 22 runtime test.

1. Install both dependency sets:

   ```sh
   npm ci
   npm --prefix functions ci
   ```

2. Copy `.env.example` to `.env.local` and keep `VITE_USE_FIREBASE_EMULATORS=true`. For QR use on phones, set `VITE_PUBLIC_ORIGIN` to this computer's reachable Wi-Fi address and Vite port, for example `http://192.168.1.10:5173`. The current local file uses this computer's verified preview address, `http://192.168.86.24:5173`. That address can change.
3. In one terminal, run:

   ```sh
   npm run emulators
   ```

   This compiles the server and starts Authentication (9099), Firestore (8080), and Functions (5001) under **demo-rpg-games**, an emulator-only namespace. It does not create a Firebase project, use cloud credentials, log into Firebase, or enable billing. Emulator tooling configuration/cache stays in ignored workspace folders. The emulator UI is local-only at http://127.0.0.1:4000.

4. In another terminal:

   ```sh
   npm run dev -- --port 5173 --strictPort
   ```

5. Open http://localhost:5173 on this computer. Choose **Invite a player**, enter a display name, and display the QR/link. Another browser/device joins through that link and waits. The host chooses New Card to begin shared play. Each browser's anonymous identity is separate; opening another tab on the same origin normally reuses the same player, so it is not a way to create a second player.

**Phone trap:** a phone's `localhost` means the phone, not this computer. Share the LAN link, keep both devices on the same trusted Wi-Fi, and ensure the local network permits ports 5173, 9099, 8080 and 5001. Emulators listen on this computer's LAN interfaces for local tests; do not expose them to the public internet or forward these ports through a router. No firewall settings have been changed by this implementation. Actual access from a physical phone remains to be checked on that phone.

The anonymous identity is saved in browser storage. Keep the same origin and session URL when reloading. Switching from `localhost` to a LAN address creates a separate browser storage origin/identity. Clearing browser data loses the anonymous identity and its access to that player's old card/prizes. There is no signup recovery. The emulator helper imports prior `.emulator-state` data when an export exists and requests export on clean shutdown; abrupt process termination can lose emulator-only server state.

## Validation

With the emulator processes running:

```sh
npm test
npm run test:multiplayer
npm run build
```

`npm test` covers the 96 solo, pattern and lifetime tests. `npm run test:multiplayer` runs 37 tests using separate authenticated Firebase client apps and actual Auth/Firestore/callable emulators. The suite verifies invite/start gating, active vs waiting players, live subscriptions, repeated numbers, physical/virtual submissions, no fixed player order (two of five players repeatedly alternating), turn enforcement, concurrent same-player and different-player requests, idempotent retries, tied wins, automatic fresh cards, waiting-player admission, prize use ownership, reconnect, invalid input and security rules.

Tie and race tests use explicitly seeded synthetic cards via test-only emulator Admin SDK access. The final browser tied-win check also used seeded cards in an isolated Preview Host / Preview Guest room, after checking the originally randomized cards and regular shared rolls. Production exposes no fixture or card-edit endpoint. Tests operate only against the demo project and fail if emulators are unavailable. They do not prove deployed cross-device service. Client-rule permission-denied messages in these tests are expected checks.

The browser flow was also checked using separate origins for distinct anonymous players, including the reachable LAN invite URL. Unit tests are not a substitute for that flow or for future cloud verification.

## Architecture and security

- Anonymous Authentication supplies stable server-verified UIDs. A caller cannot choose another player's UID in request data.
- `rooms/{id}` contains shared round/revision/marks/prize, membership, last accepted submitter, and latest result. Each player can read their own card and own `awards` subcollection. Members can read the room and completed-round summaries, not other players' cards or prizes. Session IDs use 128 random bits.
- Browser writes to rooms, cards, membership, awards and commands are denied by `firestore.rules`. All changes pass through the authenticated `gameCommand` callable.
- Each roll transaction checks membership, active eligibility, last submitter, expected round and revision. It marks, detects all winners, creates deterministic per-player/per-round award documents, rotates cards and prize, records the result, and stores the request receipt in one commit.
- Membership changes update the same room document. They therefore conflict with a simultaneous roll transaction rather than slipping through its eligibility snapshot.
- Clients include an unpredictable request ID; retrying an accepted request returns its stored receipt without applying it again. Reusing that ID with different content is rejected. Requests with stale round/revision are rejected. Virtual results and all dealt cards/prizes are generated by the trusted server.
- After a win, the last submitter remains unchanged even though the round resets. Rejected actions do not advance the turn. Used/unused updates are absolute owner-scoped values, so network retries do not accidentally toggle twice.
- The UI pauses submissions while reconnecting and checks card round before displaying it. Functions remain authoritative even if a client bypasses these UI controls.
- Production callable requests require Firebase App Check. Emulators deliberately omit App Check; this is not an instruction to disable it in cloud deployment. Maximum function instances is 3, which limits scaling but is not a spending guarantee.

## Cloud configuration and update procedure

Production project: `rpg-bingo-paul` (RPG Games), with explicitly approved pay-as-you-go billing. The web app is registered, anonymous sign-in is enabled, and the default Firestore database is in `us-central1`. App Check uses a domain-restricted reCAPTCHA Enterprise score key. The callable enforces App Check; direct client writes remain denied.

`.firebaserc` selects this production project. The local demo emulator remains a separate project (`demo-rpg-games`). No local accounts, cards, or prizes were uploaded.

To publish an update:

1. Install dependencies with `npm ci` and `npm --prefix functions ci`.
2. Configure ignored `.env.production.local` with `VITE_USE_FIREBASE_EMULATORS=false`, `VITE_FIREBASE_CONFIG` containing the public web config from `npx firebase apps:sdkconfig WEB --project rpg-bingo-paul`, and `VITE_FIREBASE_APPCHECK_SITE_KEY` containing the existing App Check site key. These are public browser settings; never include administrator credentials. Production values override the emulator-only `.env.local`.
3. Run `npm test`, start the demo emulators and run `npm run test:multiplayer`, then run `npm run build`.
4. Sign in with the Firebase CLI and deploy explicitly: `npx firebase deploy --only firestore:rules,functions,hosting --project rpg-bingo-paul`.
5. Verify Hosting, two distinct anonymous players, live shared rolls/undo, rejected unauthenticated calls, deployed rules, and the enabled hourly cleanup job. A GitHub push does not deploy automatically.

Function scaling is limited to three callable instances and one cleanup instance, with no minimum instances configured. These limits do not cap Firestore, Authentication, reCAPTCHA, or total billing costs. No spending limit or billing alert has been configured.

Production dependency audits reported zero known vulnerabilities in both the browser and function dependency sets. The development-only Firebase CLI dependency tree still has npm audit findings (including its file-watching dependency); it is not shipped in the site's assets or function runtime. Public deployment, production App Check, and cloud billing behavior have not been verified.

References: [callable functions](https://firebase.google.com/docs/functions/callable), [transactions](https://firebase.google.com/docs/firestore/manage-data/transactions), [anonymous auth](https://firebase.google.com/docs/auth/web/anonymous-auth), [local emulators](https://firebase.google.com/docs/emulator-suite/install_and_configure), [App Check with reCAPTCHA Enterprise](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider), [Functions deployment and Blaze prerequisite](https://firebase.google.com/docs/functions/get-started).


Each shared round stores one server-selected pattern for every active player. It remains fixed until bingo, when the atomic next-round deal also selects the next pattern. The completed-round summary records the winning pattern. Rooms created before patterns were introduced keep Single Line until the next round. Required target squares are outlined on every player’s own card; Single Line and Two Lines show examples and accept any completed line(s).

Leaving a room removes the caller from its roster and retains their prize records until session cleanup. The host role transfers if needed; departed players cannot submit or receive new-round cards. Every shared session stores expiresAt, extended only by accepted game actions. Expired sessions reject commands immediately, while leave remains available. Deploying the scheduled cleanupExpiredSessions function enables hourly recursive room cleanup; Firebase may require Cloud Scheduler setup during the manual deployment. Browser solo state has its own inactivity deadline and is never uploaded by this feature.

Undo my last roll is offered only to the last submitter, before another accepted roll or bingo confirmation. The trusted transaction restores the exact earlier shared marks, roll count, latest result and last-submitter rule; it advances revision and refreshes inactivity expiry. An undone repeated number retains marks from earlier rolls. Undo receipts make retries idempotent, stale tokens and concurrent rolls are rejected, and winning rolls cannot revoke awards or roll back a new round.

## Production access configuration

The organization blocks IAM grants to `allUsers`. For the game callable only, the explicitly approved Cloud Run setting `invokerIamDisabled=true` lets browser HTTP requests reach mandatory Firebase Authentication and App Check. Cleanup retains its IAM check and allows only `bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com`, matching the scheduler identity. Verify these settings after future function updates. The runtime has `roles/datastore.user`; the build identity has the approved `roles/cloudbuild.builds.builder` role in this project. See Google's [public Cloud Run access guidance](https://docs.cloud.google.com/run/docs/authenticating/public).

No image cleanup policy or billing alert is configured. The CLI may report a missing Artifact Registry cleanup policy after successful function updates; read back actual function and scheduler states. The hourly scheduler is enabled. An immediate manual cleanup test was not run.

Solo Invite and its display-name form, completed QR/link and Leave control stay beneath the solo die while the host is inviting, including after refresh. The panel moves into the shared area when shared play starts.


Bingo review and untouched-round entry: all 37 multiplayer emulator checks passed, including the real fifteen-second deadline, early-confirm/late-undo rejection, concurrent confirmation retries, winning-roll undo, immediate deals and first-roll/join races. A review holds the original pattern, prize, cards and marks. No new roll is accepted while pending. Undo restores the pre-roll state and cancels the pending win; after confirmation, prizes and the new round are final. Confirmation is automatic from connected clients; if all are offline, it completes on reconnect.

Card-tap undo: the latest submitter can tap any occurrence of their latest submitted number again to undo that shared roll. This remains available during the fifteen-second bingo review; all other numbered squares and the die stay locked. Once another player submits or bingo confirms, that undo is unavailable. Card taps and the separate Undo button use the same trusted undo command and preserve older marks when undoing a repeated number. Browser checks confirmed normal card-tap undo, winning card-tap undo, and restoration of the same round without new prizes.
