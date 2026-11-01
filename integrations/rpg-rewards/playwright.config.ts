import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 180_000, workers: 1,
  expect: { timeout: 30_000 },
  use: { baseURL: 'http://127.0.0.1:5173', channel: 'msedge', headless: true, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npm run demo:game', url: 'http://127.0.0.1:5174', reuseExistingServer: true, timeout: 60_000 },
  ],
});
