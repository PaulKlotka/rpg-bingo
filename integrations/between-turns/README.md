# Between Turns

A phone-friendly session hub for games around the RPG table. Between Turns owns guest identity, shared sessions, voting, and navigation. Games validate gameplay; RPG Rewards will manage the session-wide reward inventory.

RPG Bingo and RPG Rewards are integrated and deployed. Bingo uses the hub identity
and session, validates each game, settles Rewards, and reports completion. The hub
embeds Bingo under Current Game and the session inventory/history under My Rewards.
See [the integration contract](docs/INTEGRATION.md) and the parent repository's
`docs/INTEGRATION.md` for current deployment sources and checks.

Live application: https://between-turns-paul.web.app. Guest identity, shared sessions,
invitations, navigation, Bingo and session rewards are deployed.

## Run locally

Node.js 22.12+ (Node 24 works locally), Java 21+, and Edge for browser tests are required. The emulator launcher detects Android Studio's bundled Java on Windows.

```sh
npm ci
npm --prefix functions ci
npm run emulators
# In a second terminal:
npm run dev
```

Open http://127.0.0.1:5180. Use `127.0.0.1` consistently. Without local environment configuration, the development server connects only to the `demo-between-turns` emulators, on separate ports from the other RPG projects. Emulator data is disposable. Phone QR scans require the deployed HTTPS site; loopback invitations work on this computer only.

```sh
npm test
npm run build
npm run verify:emulators
```

The final command starts isolated emulators, runs real Firestore concurrency and access checks, then runs the two-browser UI test. It requires the emulator ports to be free. When emulators are already running, use `npm run test:integration` with `FIRESTORE_EMULATOR_HOST=127.0.0.1:8280`, and `npm run test:browser` separately.

## Player experience

- Every player is a persistent browser guest, with no signup or owner privileges. Clearing browser data creates a different guest; cross-device recovery is outside this release.
- Create a shared session, or join by QR, link, or a 15-character code. Names are unique within a session after Unicode normalization, case folding, and whitespace cleanup. Sessions support up to 32 players.
- One guest belongs to one session at a time. Switching membership is atomic; a failed join preserves the old membership. Any player can start the first selection. Late arrivals immediately enter the active game.
- Current Game, My Rewards, and Session views share one application shell. Navigation preserves an active embedded game's iframe.
- Sessions and their rewards expire 24 hours after the latest meaningful accepted activity by any member. Presence, polling, reading, refreshes, handoffs, duplicate retries, and automatic transitions do not extend expiry.
- Leaving an empty session closes it. There is no session creator role, kick control, or administrator UI.

## Selection rules

One ready game starts automatically. With two ready games both are offered; with more, three distinct games are randomly chosen. The connected members at voting start are eligible, including the player starting selection. Each votes once. Voting closes when all eligible members vote or after 30 seconds. Ties, including no votes, are resolved randomly among the highest-scoring options. A late arrival waits only for the selection and then enters immediately. An explicit departure removes that voter's eligibility and vote; a disconnected guest waits until timeout.

A trusted game backend reports each completed game once, after settling rewards. For Bingo, one confirmed win is one completed game. The hub immediately starts the next selection; games must not autonomously start another round.

## Architecture

- `shared/`: versioned data types, constants, and embedded-message validation.
- `functions/src/service.ts`: transactional membership, lifecycle, voting, grants, idempotency, and expiry.
- `functions/src/index.ts`: authenticated/App Check-enforced player callable, private service-to-service integration API, and minute maintenance job.
- `src/`: responsive browser shell, Firebase guest client, QR generation, iframe bridge, presence, reconnect, and polling.
- `tests/`: domain rules, real Firestore concurrency/access tests, and separate-browser UI tests.

All browser Firestore access is denied. Functions expose authorized views without service-account identities, connection grants, or presence connection identifiers. Session aggregates are bounded by 32 members and 100 history entries. Event receipts expire after seven days; one-use connection grants expire after 60 seconds.

Presence is approximate: heartbeats run every 20 seconds and expire after 60 seconds. Separate connections prevent one tab from disconnecting another. Server timestamps determine voting and expiry; the browser countdown compensates for clock differences. Connected clients poll every three seconds, which finalizes a timed-out vote on the next request. The maintenance job provides an offline fallback; no browser can cast a vote after its server deadline.

See [deployment](docs/DEPLOYMENT.md), [integration](docs/INTEGRATION.md), and [decisions](docs/DECISIONS.md).
