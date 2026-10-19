# RPG Games

A phone-friendly bingo companion for Starfinder Second Edition. Built with plain TypeScript, Tailwind CSS, and Vite, without a UI framework. Single-player runs locally with browser saving. Optional shared play uses anonymous Firebase Authentication, Firestore, and a trusted callable function. No account signup or analytics.

**Multiplayer setup, architecture, and manual cloud deployment:** see [MULTIPLAYER.md](MULTIPLAYER.md). Local emulator operation is prepared and tested; nothing has been deployed to Firebase.

## Play locally

Use Node.js 22.12 or newer (Node 24 LTS recommended). From this folder:

```sh
npm ci
npm --prefix functions ci
npm run dev
```

Open the Local URL printed by Vite, normally http://localhost:5173. To try it on a phone on the same trusted Wi-Fi, open the printed Network URL and allow local network access through your firewall if needed. Stop the server with Ctrl+C.

```sh
npm test
npm run typecheck
npm run build
npm run preview
```

The last command serves the production build, normally at http://localhost:4173. `dist/` is the complete static site.

## Rules

- New Card generates a randomized 5×5 board. The 24 numbered squares include all numbers from 1–20, with four distinct numbers appearing twice and none more than twice. The center is permanently free and marked.
- Tapping any numbered square toggles every occurrence of that number together.
- Rolling the d20 displays 1–20 and marks every matching square. Repeated rolls never unmark a number.
- Complete the selected winning pattern to win. Single Line accepts any full row, column or diagonal; Two Lines accepts any two distinct lines, including intersections. Completing the pattern immediately locks the card.
- The die stays available after a win. Its displayed result and count continue updating, while all card marks and winning lines stay frozen.
- Only New Card starts another card. It clears marks, roll history, and the lock. A random card can happen to repeat a previous card; draws are independent.
- The current card, offered prize, marks, win lock, die result/count, earned prizes, and used flags are saved in this browser and restored after refresh. Different browsers/devices (and different origins or ports) have separate progress. There is no cross-device sync. If storage is blocked, full, or saved data is invalid, play falls back gracefully; unavailable saving is indicated on the page.

## Bingo prizes (house rules)

Each new card independently draws one of 18 pattern categories: Single Line, Two Lines, Letters and Numbers, or one of the 15 approved named shapes. Letters and Numbers draws a character from A–Z / 0–9. Every category has equal probability; characters share their category’s probability. Cyan outlines and diamond markers show target squares, while green fill shows marked numbers. Line highlights are examples; other masks are required in the displayed orientation. Extra marks are allowed. Existing saved cards without a pattern retain Single Line until New Card. The chosen pattern survives refresh.

Each card offers one random prize from the 20-prize pool in `src/prizes.ts`, visible before play. Prize selection uses a separate random draw from the numbered squares. The prize stays fixed through toggles, die rolls, bingo, and post-win rolls. Bingo changes the display to **Prize earned**. New Card independently draws both a card and prize and resets the earned display; random prizes can repeat.

Each prize grants **+1 to one qualifying roll**, declared before rolling, usable once. Unused prizes expire at the end of the session. Only one bingo prize may apply per roll. Attack prizes affect accuracy, not damage. These are proposed bingo house rules, not official Starfinder rewards.

The **Won Prizes** section gains exactly one independent entry when a card first wins. Offered but unearned prizes are not listed. Each entry has a reversible **Mark used / Used · Undo** button. Winning the same prize on different cards creates separate entries. New Card preserves all earned entries and their used states. Refreshing a won card does not award its prize again.

Expiry is handled at the table: the app does not infer session boundaries or automatically clear prizes. Saved progress remains until browser data is removed. The used control records your own use of the bonus; it does not modify the bingo die or any Starfinder roll.

## Manual Firebase Hosting deployment (single-player only)

**Prepared only: no Firebase project has been created, project ID availability has not been checked, and nothing has been deployed.** Automatic GitHub deployments are deferred; there is no deployment workflow in this repository.

1. Open the [Firebase console](https://console.firebase.google.com/) with your own Google account and create a project with display name **RPG Games**. Select an available, globally unique project ID; the display name does not reserve an ID. Record the actual ID. Single-player needs only static Hosting. Multiplayer requires the additional setup in MULTIPLAYER.md.
2. Install the Firebase CLI and sign in:

   ```sh
   npm install -g firebase-tools
   firebase login
   firebase projects:list
   ```

3. Verify the desired project appears in the list. For a solo-only deployment, disable emulator mode in your build environment (`VITE_USE_FIREBASE_EMULATORS=false`). Build and test from this repository:

   ```sh
   npm ci
   npm --prefix functions ci
   npm test
   npm run build
   ```

4. `firebase.json` already points Hosting at `dist/`. No `firebase init` is needed. When ready to publish, replace `YOUR_ACTUAL_PROJECT_ID` below with the verified ID and run:

   ```sh
   firebase deploy --only hosting --project YOUR_ACTUAL_PROJECT_ID
   ```

5. Open the Hosting URL returned by the CLI, including on your phone. Test grouped toggles, a completed winning pattern, continued rolling after bingo, and New Card. Future manual updates repeat steps 3–5.

An explicit `--project` is used so there is no invented or accidentally selected default project. No `.firebaserc` is included. The hosting-only command uploads `dist/` and does not deploy the multiplayer backend. This setup uses Firebase **Hosting**, not App Hosting. Multiplayer needs the separate Functions and Firestore deployment documented in MULTIPLAYER.md.

Official references: [Hosting quickstart](https://firebase.google.com/docs/hosting/quickstart), [project names and IDs](https://firebase.google.com/docs/projects/learn-more#project-id), [CLI setup](https://firebase.google.com/docs/cli#install_the_firebase_cli).

## Structure

- `src/game.ts` and `src/prizes.ts`: re-export the canonical pure rules and prize pool from `functions/src/shared/`, so browser and trusted server use the same 20 prizes and approved winning patterns.
- `src/multiplayer.ts`: lazy-loaded Firebase client, invitation QR, waiting/shared UI and server-backed awards.
- `functions/src/service.ts`: authenticated transaction service for joining, starting, rolling and using owned prizes.
- `firestore.rules`: client reads scoped to membership and prize/card ownership; direct client writes denied.
- `src/session.ts`: earned instances, used flags, card identity, and versioned, validated browser-local save/restore.
- `src/main.ts`: semantic button controls and DOM updates.
- `src/style.css`: Tailwind import plus the game's responsive visual styles.
- `tests/game.test.ts`: generation, range, repeats, grouped toggles, all 12 winning lines, freeze behavior, post-win rolling, and reset tests.
- `tests/prizes.test.ts`: all prize names/qualifying rolls, selection boundaries, independent draws, stability during play and wins, and New Card reselection.
- `tests/session.test.ts`: award-once rules, separate repeated prizes, reversible use, preservation across cards, reload/restore, and corrupt or unavailable storage.
- `firebase.json`: static Hosting output and asset headers.

Keyboard users can Tab to numbered squares, the die, or New Card and press Enter/Space. Marked squares expose pressed state; win and roll results use live announcements. Free and locked card squares are disabled; the die remains enabled.

## Verification completed

- 36 automated solo rule, prize, inventory, and persistence tests passed. 16 additional emulator-backed, multi-client integration tests passed, including security-rule denials and concurrent transactions. TypeScript checking and the production build passed.
- Development and production preview servers returned HTTP 200 locally.
- Edge browser checks confirmed grouped marking/unmarking, die marking of matching squares, a winning row and locked controls, unchanged numbers and marks after a post-win roll, and New Card restoring 24 enabled numbered squares with only the center marked.
- Desktop and simulated phone widths of 390 and 320 pixels were checked. The final small-phone layout has no horizontal overflow. This was browser viewport testing, not testing on a physical phone.
- Prize-update browser checks confirmed the offered prize becoming earned, one inventory entry after a win and continued rolling, used state and card lock surviving refresh, reversible used/unused control, and New Card preserving the earned entry while offering another prize. The prize display and inventory were inspected at 390 pixels, with no horizontal overflow at 320 pixels.
- Firebase configuration parses successfully. Actual Firebase provisioning and deployment remain unverified and have not been performed.
- Final multiplayer browser checks confirmed the visible Invite button and QR/link, unchanged solo card/prize while a guest waits, host New Card transition, shared physical and virtual rolls, alternating controls, same anonymous player on reload, tied-win banner and fresh cards, and shared prize use/undo after reload. Shared and QR layouts fit at 390 and 320 pixel viewport widths. A physical phone and deployed cloud service have not been tested.

Pattern checks in `tests/patterns.test.ts` cover all approved masks, all 66 line pairs, every selectable character, free-center handling, required targets, grouped-number wins, locks, pattern persistence and legacy saves.

## Session lifetime and leaving rooms

Solo and shared sessions expire after 24 hours without game activity. Accepted rolls, solo marks, a new card, joining a new room membership, and prize-use changes extend the deadline. Refreshes, reads, repeated joins, and idempotent roll retries do not. Solo expiry starts a fresh game and clears the previous session’s prizes. Shared expiry blocks joins, starts, rolls, and prize use immediately. The page shows an expired-session notice and lets players leave.

Leave room is always available, including while waiting or disconnected. It returns immediately to the saved solo game, clears the invite URL, and detaches shared subscriptions. A departure is queued in browser storage when the service is unavailable and retried when connectivity returns or multiplayer opens again. Leaving removes membership; host responsibility passes to a remaining member. Fewer than two active players pauses shared rolls. Empty rooms close. Rejoining an open room uses the normal waiting rule and retains that player’s earlier prizes until expiry.

The shared UI supports card taps and the shared die. The manual result form was removed; room information, the QR code, and the join URL are shown directly beneath the shared die.

The cleanupExpiredSessions scheduled function runs hourly after cloud deployment and removes expired rooms recursively, including players, prizes, rounds and request receipts. It processes up to 20 rooms per run and retains a retry tombstone on deletion failure. The local integration suite invokes the same cleanup function directly; the demo emulator does not run the cloud schedule. No cloud deployment or scheduler activation has been performed.

Final validation for patterns, departure and expiry: 96 solo/pattern/lifetime checks and 25 emulator integration checks passed, plus the production build. A two-player browser check confirmed the same Turtle mask on distinct cards, permanently visible room QR/link beneath the die, removal of the typed-result form, and leaving both an invite screen and active shared play to return to the preserved solo game. A fresh invite was successfully created after leaving. Existing local demo rooms were given an initial 24-hour deadline without altering their cards, prizes or rosters.

Shared Undo: after an accepted non-winning roll, its submitter can choose Undo my last roll beneath the shared die. This restores everyone’s prior marks and turn eligibility. It is unavailable after another player submits or after bingo advances the round. Previously marked numbers remain marked if the undone roll repeated them. Undo applies to card taps and virtual die rolls.

Undo validation: production build, all 96 solo/pattern/lifetime checks and all 32 emulator integration checks passed. The live browser check submitted 20 by card tap, displayed the submitter-only Undo control, then restored unmarked 20 squares and first-roll eligibility after Undo.
