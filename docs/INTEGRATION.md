# Bingo in Between Turns

The Between Turns v1 integration is implemented and deployed across all three
projects. Play at https://between-turns-paul.web.app. Bingo runs at `/embed`;
Rewards supplies the embedded inventory and session reward history. The hub owns
authentication, membership, session expiry, navigation and next-game selection.
Joint service tests against separate Firestore emulator databases have passed.

## Responsibilities

| Application | Owns |
| --- | --- |
| Between Turns | Authentication, player names, membership, invitations, session expiry, navigation, active game runs and next-game selection |
| RPG Bingo | Cards, shared numbers, patterns, turn validation, undo, win detection, fifteen-second review and durable result reporting |
| RPG Rewards | Reward selection, immutable offers, tied-winner settlement, inventory, consumption and reward history |

Standalone `/` keeps the original behavior and its existing saves. Embedded mode
does not initialize that application or its Firebase guest login. Old Bingo
sessions and prizes are not imported. The embedded UI contains only the current
game; reward inventory and session navigation belong in the hub's other views.

## Browser and backend connection

The hub loads `/embed?btVersion=1&btNonce=...&btParentOrigin=...`. The child
independently checks the exact parent origin against `VITE_BETWEEN_TURNS_ORIGINS`
(default `https://between-turns-paul.web.app`), its message source and nonce.
Hosting permits that production origin through `frame-ancestors`.

The child first calls same-origin `/embeddedApi` with `{action:'begin', nonce}`.
The server creates a random pending browser credential, storing only its hash.
The credential stays in frame memory and travels only in an Authorization header;
it never uses cookies, URLs, Firebase token fields or persistent browser storage.
The child sends `ready`, accepts only the matching parent's unexpired `connect`
grant, and submits `{action:'connect', nonce, grant}` with its pending credential.
The backend exchanges the one-use grant with Between Turns using its own Google
OIDC runtime identity. A connection binds central IDs on the server and expires
after at most one hour. Reload the iframe to reconnect. No frontend-supplied
player/session/run IDs or win claims authorize operations.

Each `view`, `roll` and `undo` revalidates central membership, expiry and the
active run. A run maps to exactly one round, initialized transactionally.
Players receive distinct random cards with the same pattern and shared called
numbers. Late arrivals inherit existing calls. Solo play is supported; with
multiple current participants submitters alternate. Moves require the current
revision and a stable request ID. Reusing an ID with another payload is rejected.
Direct Firestore access to the new collections remains denied by the existing
catch-all security rule. Other players' cards are omitted from browser responses.

## Rewards API

The configured private Rewards game API implements these operations using
**Between Turns identifiers**, with central context validation instead of its
legacy independent session/membership model:

```json
{"action":"draw","sessionId":"CENTRAL_SESSION","playerId":"CENTRAL_PLAYER","runId":"CENTRAL_RUN","requestId":"STABLE_OFFER_EVENT"}
```

Return `{result:{id, reward:{id, name, qualifyingRoll}}}`. A retry must return the
same immutable offer for this registered game/session/run. Bingo persists this
offer before permitting play. Only Rewards chooses its reward.

```json
{"action":"settle","sessionId":"CENTRAL_SESSION","runId":"CENTRAL_RUN","offerId":"OFFER","winnerIds":["CENTRAL_PLAYER"],"requestId":"STABLE_SETTLEMENT_EVENT"}
```

Return `{result:{receipt:"DURABLE_REFERENCE"}}`. This operation is implemented in
`integrations/rpg-rewards/functions/src/central-service.ts`. It validates the registered Bingo backend,
the offer's game/session/run binding, and every winner's current central context;
atomically award all tied winners once; and persist the receipt. Reject a different
payload under the same request ID. Exact retries, including after the hub has
completed the run, must return the original receipt without new awards or activity.
Receipt and offer IDs use 1–128 ASCII letters, digits, underscores or hyphens.
Errors use `{error:{code,message}}` with the matching HTTP status.

The legacy Rewards `exchange`, `session` and per-player `award` flow is not used.
Embedded Rewards pages must obtain their own hub handoff and show the central
session's inventory and history. Bingo's runtime needs only the private game API.

## Completion and recovery

Winning rolls lock all cards for fifteen seconds. Only the submitter can undo
before that server deadline; undo restores previous calls, count and submitter,
and cancels the proposed winners. Confirmation freezes the original cards,
offer and winner list in a durable `settling` record. Bingo never redeals or
starts the next run independently.

Accepted moves store activity outbox records in the same Firestore transaction.
They are retried with stable IDs before further gameplay. Review/settlement is
retried by connected clients and a minute scheduler. The backend settles Rewards,
stores the returned receipt, then sends the hub's `complete` command with the
same run, winners, event ID and receipt. A lost settlement response is retried
against Rewards' receipt; a lost completion response reuses the saved receipt
without awarding again. Failures leave the game locked for retry. There is no
cross-service transaction: central membership can change between calls. A departed
winner or expired session fails closed and requires operational reconciliation;
Bingo does not silently change confirmed winners or skip unpaid awards.

Views, polling, reconnects, initialization and confirmation do not themselves
report hub activity. Rewards is responsible for central activity for actual new
offers and awards. No independent Bingo inactivity clock applies to embedded play.

## Configuration and release

1. Set server `BETWEEN_TURNS_API_URL`, `REWARDS_GAME_API_URL` and
   `BINGO_BROWSER_ORIGINS` (see `functions/.env.example`). Keep credentials out of
   frontend environment variables. Runtime authentication uses Application Default
   Credentials, with no downloaded private keys.
2. Register `rpg-bingo`, its hosting origin, and
   `bingo-runtime@rpg-bingo-paul.iam.gserviceaccount.com` in Between Turns
   `APPS_JSON` and Rewards' backend registry. Grant this runtime `roles/run.invoker`
   on just those two integration API services. The browser endpoint is public,
   but requires a protected pending/connected credential for sensitive requests.
3. Deploy Bingo's functions and Hosting rewrites. `/embeddedApi` reaches the
   public browser function; the hub and Rewards endpoints remain private.
4. Add Bingo's exact origin to the hub's Hosting `frame-src` CSP. Implement and
   deploy the central Rewards adapter and its embedded views.
5. Jointly test two hub players, late entry, departure, solo play, review/undo,
   refresh, inventory use/history, a Rewards outage, duplicate settlement,
   completion after a lost response, expiration and navigation at phone widths.
   Only then mark `rpg-bingo` ready with the `/embed` URL in `GAMES_JSON`.

All three Firebase projects have been deployed. The registry enables Bingo and
the embedded Rewards app. Scoped `roles/run.invoker` grants connect only the
registered runtimes to the private backend APIs. Both minute retry schedules are
enabled. Browser transports accept opaque server-bound credentials; backend APIs
reject unauthenticated calls with HTTP 403. Hosting allows the exact embed origins.

The original Hub and Rewards folders were read-only in this session. Updated
deployment sources are in `integrations/between-turns` and
`integrations/rpg-rewards` inside this repository. Their original folders were
not changed. See `integrations/README.md` before updating or redeploying them.

## Local verification

`npm test` covers standalone regression rules, embedded state transitions and
iframe message validation. `npm run build` checks frontend/functions types and
builds both entry paths. `npm run test:embedded` requires a loopback Firestore
emulator in `FIRESTORE_EMULATOR_HOST` and uses fake hub/Rewards gateways with real
Firestore transactions to exercise connection binding, concurrency and recovery.
`npm run test:full-integration` exercises the real Hub, Rewards and Bingo services
against separate emulator databases, including tied wins, undo, retry after a
committed reward response is lost, hub advancement, inventory ownership,
consumption/undo, wrong-run rejection and departure/expiry checks.

Verification for this change: 101 unit tests, 10 Firestore integration tests,
TypeScript checks and the production build passed. Headless Edge checks verified
the iframe handshake, 25-square board, absent standalone controls, unchanged move
IDs on retry, undo, no browser-stored credentials, and no horizontal overflow at
1440, 390 and 320 pixels. The standalone entry also loaded successfully. The
initial browser checks used simulated API responses. The deployed check is
`node scripts/verify-live-integration.cjs`, which uses normal player UI actions
and leaves its temporary test session when finished. No production win endpoint
or seeded cards are used. `RPG_TEST_SYSTEM_CA_RELAY=true` optionally routes Google's
requests through Node's verified system-CA HTTPS transport for Windows browser
network problems; Firebase Authentication and App Check remain enforced.

The deployed two-player acceptance check passed: shared cards/rolls, a confirmed
win on roll 17, reward recording, automatic next-game start, reward use and undo,
inventory persistence after reload, iframe-only reload/reconnection, navigation
preserving the game frame, and 390/320-pixel layouts without horizontal overflow.
Headless Edge required the optional system-CA transport for Google's requests;
the test used real production Authentication, App Check, backend IAM and databases.

For joint local testing, run all three backends on their existing distinct
emulator ports and register `rpg-bingo` in the hub's emulator registry.
Rewards implements the central contract above. Vite proxies `/embeddedApi` to Bingo's
Functions emulator on port 5001. Set the local Bingo origin in
`BINGO_BROWSER_ORIGINS` and the hub origin in `VITE_BETWEEN_TURNS_ORIGINS`.
Emulator-only service headers are enabled solely by `FUNCTIONS_EMULATOR=true`.
