import { defineConfig } from '@playwright/test';

// Explicit opt-in command: npm run test:live. Creates disposable 24-hour guest sessions.
export default defineConfig({
  testDir: './tests/live', timeout: 180_000, workers: 1,
  expect: { timeout: 45_000 },
  use: {
    baseURL: 'https://rpg-rewards-paul.web.app',
    channel: 'msedge', headless: true, trace: 'off',
  },
});
