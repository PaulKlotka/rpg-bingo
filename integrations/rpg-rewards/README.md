# RPG Rewards

## Current Between Turns integration

The deployed app now uses Between Turns authentication, membership and session
expiry. `/embed` shows the current player's rewards and the session reward history,
with owner-only use/undo. The root page links to the hub. No independent Rewards
session is created for integrated play.

The private `gameApi` accepts central `draw` and atomic tied-winner `settle`
operations. Immutable receipts and a durable activity outbox prevent duplicate
awards and support process restart. The hub validates the registered game and
active run before new offers or settlements; inventory survives successive runs
within the same hub session.

Play at https://between-turns-paul.web.app. Current deployment sources are in
the parent Bingo repository's `integrations/rpg-rewards` folder. The original
`C:\GitHub\rpg-rewards` folder was read-only and is unchanged. See the parent
`docs/INTEGRATION.md` for the integration contract and verification commands.

The remaining text describes the retained legacy standalone service and its
original tests. That UI is not loaded by the current deployed entry point.

A standalone, phone-friendly Starfinder Second Edition reward inventory. Guest players pool winnings from different games inside a selected solo or shared session. The main page shows only the player's own rewards; Session winners shows everyone awarded a reward in that session.

This repository does not modify, deploy, or connect the existing RPG Bingo application. It copies its 20 house-rule rewards and includes a separate local sample game for API verification. No cloud project has been created.

## Run locally

Requirements: Node.js 22.12 or later, Java 21 or later for the Firestore emulator, and Microsoft Edge for the browser checks. The emulator launcher also detects Android Studio's bundled Java on Windows.

```sh
npm ci
npm --prefix functions ci
npm run emulators
```

In two additional terminals:

```sh
npm run dev
```

```sh
npm run demo:game
```

Open http://127.0.0.1:5173. Development defaults to the local `demo-rpg-rewards` project if no Firebase configuration is supplied. Use the literal `127.0.0.1` hostname consistently. Emulator ports differ from RPG Bingo's ports so the projects can run independently. No production resources are contacted by the local demo.

1. Enter a player name and create a solo or shared session.
2. For shared play, scan the party QR code or open its join link, enter a player name, then choose Join session. The 12-character code is filled in automatically and remains available for manual entry. QR generation happens locally; no invitation is sent to an external QR service. In this loopback-only preview, links open on this computer; phone scanning requires the deployed site at a reachable HTTPS address.
3. Open http://127.0.0.1:5174, choose Connect your player, and approve the selected session in Rewards.
4. In the sample game, draw a reward, then record a win. Recording it repeatedly awards it only once.
5. Return to Rewards to use the reward or undo its consumption. Another player sees the award under Session winners, but cannot consume it.

The guest identity persists in this browser across reloads. Clearing site data, using a private window, or changing browsers creates a different identity. Guest recovery across devices is not implemented. The demo backend keeps its own connection in memory and requires reconnection after restarting. Emulator data is intentionally temporary.

## Verify

```sh
npm test
npm run build
npm run verify:emulators
```

The last command starts isolated local Auth, Firestore and Functions emulators, runs the integration tests, and shuts them down. If the emulators are already running, use:

```sh
# PowerShell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8180'
npm run test:integration
npm run test:browser
```

The browser suite starts Vite and the sample game if needed; it requires the Firebase emulators to be running. It exercises two separate browser identities, the cross-origin game handoff, stable offers, retry-safe awards, consumption, undo, refresh persistence and 1440/390/320-pixel layouts. Integration tests advance an injected server clock to verify expiry immediately, including before cleanup. Their test records are isolated by random player IDs, but the expiry cleanup test can remove other expired emulator sessions. Run against disposable emulator data only.

## Session and reward rules

- One central Firebase Authentication project issues anonymous player identities. Session membership is separate from identity; one player can belong to several sessions simultaneously.
- Players create solo sessions or shared sessions. Solo sessions cannot be joined by other players. A shared join code admits a guest to the shared session.
- Rewards from all games pool within a session, and never cross into another session's pool.
- All sessions expire after 24 hours of inactivity. Creating a session sets its first deadline. New membership, a new reward offer, a new award, accepted gameplay activity, and an actual consumption/undo change extend that deadline.
- Reads, refreshes, identity handoffs, repeated joins, no-op consumption, duplicate awards and idempotent request retries do not extend it. Games must report accepted gameplay through `activity`; reads or periodic heartbeats must not be used for this.
- Expiration is checked on the server for every session operation. Expired rewards become unavailable immediately, irrespective of when cleanup deletes them. Expiration applies to consumed and unconsumed rewards together.
- The hourly cleanup removes expired sessions, subcollections and join codes. Failed recursive deletion leaves an expired parent eligible for another cleanup attempt. One-time connection grants expire after 60 seconds; global create-session receipts are retained for seven days.
- The hardcoded catalog is shared by every game. Each draw independently selects an equally likely reward. Repeated rewards have independent award records. An offered reward is immutable; an award uses its stored definition, rather than looking up a potentially changed catalog entry.
- One offer can be awarded once per winner, allowing tied winners. A later win should draw a new offer. Only an award's owner can consume it or undo consumption.
- Every reward grants +1 to one qualifying roll, declared beforehand and usable once. Only one reward applies per roll; attack rewards affect accuracy, not damage. These are copied house rules, not official Starfinder rewards.

## Architecture

- `shared/`: catalog and transport/data types used by frontend and backend.
- `src/`: Vite player UI and central anonymous Firebase client.
- `functions/src/service.ts`: transactional session, membership, offer, award, handoff, idempotency and cleanup logic.
- `functions/src/index.ts`: guest callable function, game backend HTTP API and scheduled cleanup.
- `demo/`: local-only sample game backend. No credentials or game privileges are shipped to the player frontend.
- `docs/API.md`: integration contract, identity handoff and authorization.
- `docs/DEPLOYMENT.md`: future project setup and deployment checklist.

Firestore stores sessions with member ID indexes and member/offer/award/receipt subcollections. All client Firestore reads and writes are denied; authenticated functions return the allowed player inventory and session history. Mutations are transactions, and request receipts reject reuse with different input. The game API also deduplicates awards across different request IDs by offer and winner.

Future account sign-in can link a provider to the central anonymous Firebase account, retaining its UID and records. Signing into an already-existing account requires an explicit merge flow; that is outside this guest-only release. Guests are technically authenticated anonymously today, with no sign-up screen.

## Scope

Included: central guest identity, local cross-origin identity handoff, session creation/joining/selection, catalog, reward offers, awards, consumption/undo, session winner history, trusted backend API, expiry and cleanup, local tests and deployment templates.

Not included: an administrator login or editor, a new Firebase project, billing changes, deployment, bingo integration, import of existing bingo sessions/rewards, permanent account screens, cross-device guest recovery, or proof that a third-party game actually detected a win. Registered game backends remain responsible for validating gameplay and the player identity in their own sessions.

## Local verification completed

Verified on Windows with Node.js 24, Java 21, and headless Microsoft Edge: 3 unit tests, 13 Firebase emulator integration tests, TypeScript checking, the frontend/functions build, and the two-player browser scenario passed. Browser checks include session switching and layouts at 1440, 390, and 320 pixels, with screenshots visually inspected. The deployed Functions runtime target remains Node.js 22. Cloud IAM, App Check, hosting and scheduler acceptance checks are deferred until deployment.
