# Between Turns integration contract, version 1

This document is the implementation handoff for later updates to RPG Bingo and RPG Rewards. Neither existing app is connected in the initial release. The local test suite is the reference adapter; production does not expose test-game or simulated-win controls.

## Ownership

| Component | Authoritative responsibilities |
| --- | --- |
| Between Turns | Anonymous player identity; one active session per player; unique session names; invitations; membership; presence; shared inactivity deadline; active game instance; selection; navigation |
| Game backend | Validating moves and wins; durable game state and per-player cards; immediately admitting new members; retry-safe reward offers and awards; announcing readiness and completion |
| RPG Rewards | Own inventory and awards implementation, keyed by Between Turns `sessionId` and `playerId`; authorized consume/undo; expiry checks through the central context |

The same central identifiers must be used everywhere. Do not infer shared Firebase identities from origins or reuse a game-local UID as the central ID. Old Bingo/Rewards sessions are not imported. Guest recovery and account linking are outside v1.

## Register an app

Deploy the integration backend first. Set `APPS_JSON` in the Between Turns function environment:

```json
[
  { "id": "rpg-bingo", "kind": "game", "origin": "https://rpg-bingo-paul.web.app", "serviceAccount": "GAME_RUNTIME@GAME_PROJECT.iam.gserviceaccount.com" },
  { "id": "rpg-rewards", "kind": "rewards", "origin": "https://rpg-rewards-paul.web.app", "embedUrl": "https://rpg-rewards-paul.web.app/embed", "serviceAccount": "REWARDS_RUNTIME@REWARDS_PROJECT.iam.gserviceaccount.com" }
]
```

Use real service-account emails in configuration. Give each app a distinct runtime identity and `roles/run.invoker` on **only** the Between Turns integration API's Cloud Run service. These identities do not need direct database access. `GAME_API_AUDIENCE` is the exact deployed integration API URL. Obtain a Google service-account OIDC token for that audience using the backend's runtime identity, and send `Authorization: Bearer ID_TOKEN`. The API verifies the Google issuer, signature, audience, verified email, and exact registry match. Player Firebase tokens are not accepted as backend credentials.

Only after successful end-to-end testing, mark a game ready in `GAMES_JSON`:

```json
[{ "id": "rpg-bingo", "name": "RPG Bingo", "description": "Match numbers, complete a pattern, and earn a little extra luck.", "ready": true, "embedUrl": "https://rpg-bingo-paul.web.app/embed" }]
```

An empty catalog override keeps the built-in Bingo placeholder. A game cannot be ready without a registered backend and matching HTTPS embed origin. Only one Rewards app is allowed. Add the exact embed origins to Firebase Hosting's `Content-Security-Policy` `frame-src` directive before enabling an embed. The embedded applications must allow the Between Turns origin in their own `frame-ancestors` policy.

## Browser handshake

The hub mounts an iframe once per game instance, then hides it when another view is selected. Its URL contains only `btVersion=1`, a random `btNonce`, and `btParentOrigin`. These are public correlation values, never authentication credentials.

Every message has `{ channel: 'between-turns', version: 1, type, nonce }`. The hub verifies exact `event.origin`, `event.source === iframe.contentWindow`, version, type, and nonce. Children must independently allowlist the hub origin and verify `event.source === parent`; do not blindly trust the URL's parent-origin value. Never use wildcard `postMessage` targets.

1. Child backend establishes its own protected browser session and binds a pending connection to the supplied nonce. Child sends `type: 'ready'` to the validated parent origin.
2. The hub invokes its guest-only `connect` command. Between Turns creates a random, single-use 60-second grant bound to the app, guest, session, optional active run, and nonce. Only its hash is stored.
3. Hub replies to the exact child origin with `type: 'connect'`, `grant`, and `expiresAt`. The grant is never placed in the URL, persistent browser storage, logs, or a Firebase token field.
4. Child sends the grant and nonce to its backend over HTTPS. Its backend validates its own pending browser connection and calls the private `exchange` operation with its registered service identity.
5. Backend stores the returned central context in its protected session, then the child sends `type: 'connected'`.
6. Child may send `type: 'refresh'` after a backend operation. The hub rereads trusted state. `type: 'error'` reports a connection problem. Neither message changes membership, awards, active games, or deadlines.

An embedded backend must support browsers with third-party cookie restrictions, for example by keeping an opaque, short-lived browser-session credential in frame memory. Do not assume cross-site cookies will be available. That credential may reference only the server-bound central context, not arbitrary player-supplied IDs. Reloading the frame starts a fresh grant exchange.

## Backend API

`POST INTEGRATION_API_URL` accepts a JSON command and returns `{ "result": ... }` or `{ "error": { "code": "...", "message": "..." } }`. Requests are capped at 8 KiB. All IDs are 1–128 ASCII letters, digits, underscores or hyphens. Keep event IDs stable across retries, and reuse the exact payload.

### Exchange

```json
{ "action": "exchange", "token": "ONE_USE_GRANT", "nonce": "PENDING_BROWSER_NONCE" }
```

Returns `{ version: 1, playerId, displayName, sessionId, runId, expiresAt }`. Rewards receives a null `runId`. Reject replay, expiration, wrong app, wrong nonce, departed membership, and old game runs. If a response is lost after redemption, begin a new handshake.

### Validate current context

```json
{ "action": "context", "sessionId": "CENTRAL_SESSION_ID", "playerId": "CENTRAL_PLAYER_ID", "runId": "GAME_RUN_ID" }
```

Returns the same context. Rewards omits `runId`. Games must supply it and verify the run is still active. Read this before admitting a player, validating a move, or changing rewards. A context read and exchange never extend inactivity. Do not cache membership or expiry beyond an operation; leaving or changing sessions invalidates access. Local game state may remain for cleanup but cannot authorize future actions.

### Meaningful activity

```json
{ "action": "activity", "sessionId": "CENTRAL_SESSION_ID", "playerId": "CENTRAL_PLAYER_ID", "runId": "GAME_RUN_ID", "eventId": "DURABLE_GAME_EVENT_ID" }
```

Returns `{ accepted: true }`. Games report only newly accepted gameplay. Rewards omits `runId` and reports actual new offers, awards, or consume/undo changes. Reads, no-ops, heartbeats, refreshes, iframe visibility, and duplicate events must not report activity. The API deduplicates event IDs transactionally; different payloads under the same ID are rejected. Session expiry is shared, never maintained independently by embedded apps.

### Complete a game

```json
{ "action": "complete", "sessionId": "CENTRAL_SESSION_ID", "runId": "GAME_RUN_ID", "eventId": "DURABLE_COMPLETION_EVENT_ID", "winnerIds": ["CENTRAL_PLAYER_ID"], "rewardsReceipt": "DURABLE_REWARD_SETTLEMENT_REFERENCE" }
```

The game backend must validate and finalize the result, then idempotently settle all associated awards through Rewards **before** submitting completion. `rewardsReceipt` is the registered backend's attestation/reference; v1 does not cryptographically verify a separate Rewards receipt. Persist an outbox record so a process restart retries reward settlement and completion without duplication. Never trust browser-supplied win claims, winner UIDs, or settlement receipts.

Only the backend registered for the active game can complete its current run. Winners must be unique current members; an empty list is allowed for games without a winner. A successful completion records one result, then starts the next selection or immediately starts the sole ready game. Retries return success without repeating transitions or extending expiry. A new event for an old run is rejected. Game backends should stop writes to completed runs even if a browser remains connected briefly.

There is no distributed transaction between the hub and a future Rewards service. Durable, idempotent settlement and outbox retries are required; a failure must leave the old game awaiting completion rather than losing awards.

## Game initialization and late joins

The exchanged context's `runId` identifies the single shared game instance. The first connected player may cause the game backend to create that instance transactionally; subsequent players join that same instance. `context` validates each participant. Deal late joiners an appropriate game state immediately. Preserve the run across iframe navigation and refresh; a new `runId` always means a new game instance.

For Bingo: map one hub run to one Bingo round; retain its win-review/undo semantics; settle confirmed winners and rewards; report completion only after confirmation; disable its automatic next round and independent session/create/join UI in embedded mode. Keep native standalone behavior separate if desired.

For Rewards: embedded mode accepts the supplied central session and guest; hide independent create/join controls; pool inventory across run IDs within that session; preserve owner-only use and undo; revalidate central membership and expiry before inventory operations. Never move inventory into another session when a player switches.

## Failure and timing

Expired sessions reject all writes even before maintenance deletes records. Presence is approximate with a 60-second lease. Votes reject late submissions at the 30-second server deadline, regardless of client clocks. Connected hub clients resolve timed-out votes on their next poll; minute maintenance is the offline fallback.

Errors: `invalid-argument` 400, `unauthenticated` 401, `permission-denied` 403, `not-found` 404, `already-exists` 409, `failed-precondition` 409, `resource-exhausted` 429. IAM may reject unauthorized requests before the JSON handler. Reconnect by obtaining a fresh grant, not by inventing a new guest or accepting a browser-supplied context.
