import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 90_000, workers: 1,
  expect: { timeout: 20_000 },
  use: { baseURL: 'http://127.0.0.1:5180', channel: 'msedge', headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5180', reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
