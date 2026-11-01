# Game backend API

Base endpoint: `POST https://REGION-PROJECT.cloudfunctions.net/gameApi`. Every operation takes a JSON object and returns `{ "result": ... }` or `{ "error": { "code": "...", "message": "..." } }` with a matching HTTP status. Responses are not cached.

## Trust and credentials

Only registered game service accounts may call this endpoint. It is deployed with private invocation. Grant each registered runtime service account `roles/run.invoker` on this function's underlying Cloud Run service, then register the same email in `GAME_CLIENTS_JSON`.

The game backend obtains a Google service-account OIDC ID token whose audience is the exact endpoint URL and sends `Authorization: Bearer ID_TOKEN`. `GAME_API_AUDIENCE` must match that URL. The handler independently verifies signature, issuer, audience, verified email and registration before using the mapped game ID; the caller cannot supply its own game identity in the JSON body. See [Google service-to-service authentication](https://cloud.google.com/run/docs/authenticating/service-to-service).

Google Auth Library example (in the game backend, using its runtime service account):

```ts
import { GoogleAuth } from 'google-auth-library';
const url = process.env.REWARDS_GAME_API_URL!;
const client = await new GoogleAuth().getIdTokenClient(url);
const response = await client.request({
  url, method: 'POST',
  data: { action: 'activity', sessionId, playerId, requestId: gameplayEventId },
});
```

Do not use a player's Firebase ID token as game authorization. Never put game service-account keys in frontend code. Prefer workload identity / the hosting runtime's service account over downloaded private keys.

The loopback Functions emulator accepts `X-Emulator-Game: demo-game` or `other-game` instead. This shortcut is selected only by Firebase's server-side `FUNCTIONS_EMULATOR=true`, never by a request or frontend environment value. `demo/game-server.ts` is an emulator-only adapter and must not be deployed.

## Connect a player across websites

The Rewards website owns the persisted central guest identity. Firebase project separation does not create a shared browser login across origins.

1. The game backend creates a cryptographically random state value and binds it to that browser's server session. Redirect the browser to Rewards with `gameId`, the registered `redirectUri`, and `state` query parameters.
2. The player creates, joins or selects a session and explicitly chooses Continue to game.
3. The Rewards callable verifies guest identity, session membership and an exact allowlisted callback URI. It issues a random, single-use, 60-second code, storing only its hash, bound to the player, session, game and callback.
4. The browser is redirected to the registered callback with `code` and the original `state`. No Firebase credential is put in a URL.
5. The game backend validates state against its browser session, then calls `exchange` below with its own backend credential. Rewards checks the binding and deletes the code atomically.
6. The game stores the returned player/session IDs in its protected browser session, removes the code from the URL and uses those server-held values for future requests. Do not accept an arbitrary winner UID supplied by a player browser.

Codes cannot be exchanged by another game, replayed, or used after the session expires. Handoffs do not extend inactivity. The central browser guest identity can be reused across several games; connecting another session should create/select the corresponding game-side session context.

## Operations

### Exchange a connection code

```json
{ "action": "exchange", "code": "ONE_TIME_CODE", "redirectUri": "https://GAME_HOST/callback" }
```

Returns `{ playerId, sessionId, displayName }`. Save the result securely. If the response is lost after successful redemption, start a new handoff; this operation intentionally cannot replay a consumed code.

### Read the session

```json
{ "action": "session", "sessionId": "SESSION_ID", "playerId": "CENTRAL_PLAYER_ID" }
```

Returns `SessionView`: session, members, that player's inventory and all awards in current-session history. This is a read and does not extend expiration.

### Draw an offer

```json
{ "action": "draw", "sessionId": "SESSION_ID", "playerId": "CENTRAL_PLAYER_ID", "requestId": "UNIQUE_GAME_EVENT_ID" }
```

Returns `{ id, gameId, sessionId, reward: { id, name, qualifyingRoll }, createdAt }`. Save the offer ID in the game round's durable backend state before displaying it. The requesting player must be a member, but is not designated as the winner. Draw once for each round/offer; retries must reuse the same request ID. A newly committed offer extends inactivity.

### Award the exact offer

```json
{ "action": "award", "sessionId": "SESSION_ID", "playerId": "WINNER_CENTRAL_PLAYER_ID", "offerId": "OFFER_ID", "requestId": "UNIQUE_WIN_EVENT_ID" }
```

Returns an `Award`: `{ id, offerId, gameId, playerId, playerName, reward, awardedAt, consumedAt }`. Only the originating game can award an offer. The winner must belong to the session. Repeating an award with a different request ID still returns the existing award for that offer/winner without extending expiration. For tied winners, call once per member with distinct request IDs. A later win, including the same reward for the same player, uses a new offer.

### Report accepted gameplay

```json
{ "action": "activity", "sessionId": "SESSION_ID", "playerId": "CENTRAL_PLAYER_ID", "requestId": "UNIQUE_GAMEPLAY_EVENT_ID" }
```

Returns `{ accepted: true }` and extends expiration once. Report meaningful accepted gameplay such as a roll, mark or a new round; never report polling or refreshes. Reuse the gameplay event ID on network retries.

## Idempotency and errors

IDs must contain only letters, digits, hyphens or underscores and be at most 128 characters. Request IDs are scoped to a game and session across all mutation types; reuse with different input returns `already-exists` (409). Keep request IDs in durable game state until the request succeeds so reconnects do not manufacture new offers. The sample backend keeps IDs only in memory because it is a disposable local example.

Common errors: `invalid-argument` (400), `unauthenticated` (401), `permission-denied` (403), `not-found` (404), `already-exists` (409) and `failed-precondition` (409, including session expired). Firebase IAM may reject an unauthorized caller before it reaches this JSON handler. Expired sessions cannot be revived by requests; create a new session.

## Guest player callable

The Rewards UI uses `playerCommand` through the Firebase callable SDK, carrying central anonymous Authentication and production App Check. Commands are `list`, `view`, `create`, `join`, `consume`, and `connect`. Players cannot invoke game `draw`, `award`, or `activity` commands through this callable.

Create: `{ action: 'create', requestId, name, kind: 'solo' | 'shared', displayName }`.
Join: `{ action: 'join', joinCode, displayName }`.
Consume/undo: `{ action: 'consume', sessionId, awardId, consumed: boolean, requestId }`.
List/view and connect are illustrated by `src/client.ts` and `src/main.ts`.
