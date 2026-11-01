# Product decisions

Interview completed October 31, 2026.

- Guest players only; all have the same permissions. The creator has no special role.
- A session is one shared group, joined through a QR code, invitation link, or session code. One guest can belong to one session at a time.
- Each player enters a name unique within that group. All players share the same active game. Late joins enter it immediately.
- Shared inactivity expiration is 24 hours after the last meaningful action by any member. Rewards carry across games until session expiration.
- Any member may initiate the first selection. A completed game automatically initiates every later selection. One confirmed Bingo win is one game completion.
- Offer three randomly selected ready games, or all games if only two are ready. Automatically start the sole ready game. Offer no unintegrated game as playable.
- Voting includes connected members when selection opens, closes after all eligible votes or 30 seconds, and resolves ties randomly. Each guest casts one vote. No votes means a random offered game. Late joiners enter the selected game; explicit departures remove the voter and vote, disconnections wait for timeout.
- Current Game, My Rewards, and Session are separate views; navigation preserves the game.
- Initially show integration placeholders, not live standalone pages with unrelated sessions.
- Implement and deploy Between Turns independently. Do not modify the existing Bingo/Rewards projects. Their future updates will implement the versioned integration contract.

Implementation bounds: 32 members, 100 recent results, up to eight simultaneous browser tabs per player, 60-second presence leases, three-second synchronization polling, 60-second single-use handoff grants, and seven-day event receipts. Browser refresh preserves guest identity; browser data deletion and cross-device recovery are outside this release. Session codes contain 60 random bits and are invitation secrets, not public directory entries.
