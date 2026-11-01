# Integrated deployment sources

These are working copies of `C:\GitHub\between-turns` and
`C:\GitHub\rpg-rewards`, prepared here because this Codex session may read but
cannot write those original folders. The original folders were not modified.
The copies retain the existing public production environment configuration and
use the already installed dependencies through local directory junctions.
Environment files, CLI authentication caches and dependencies remain ignored.

The deployed integration is built from these copies and the parent Bingo project.
Install dependencies normally if moving these sources to another machine. Their
source changes can be copied back to the original repositories when those folders
are made writable; retain their existing ignored environment files.

Production projects: `between-turns-paul`, `rpg-rewards-paul`, `rpg-bingo-paul`.
All deployment commands pass an explicit project. The browser uses Between Turns
for authentication, membership, inactivity expiry and navigation. Rewards owns
offers, awards, inventory and consumption. Bingo validates gameplay and submits
only confirmed results. The private backend APIs use registered service accounts.

Run `npm run test:full-integration` in the parent project with a loopback
`FIRESTORE_EMULATOR_HOST` to test all three services against separate databases.
`scripts/configure-integrations.cjs` configures only the required service-level
invocation grants and the protected browser transports after deployment.
