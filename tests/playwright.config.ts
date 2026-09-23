import { defineConfig, devices } from '@playwright/test';

// DEMO=1 runs headed and slowed down, so the smoke test doubles as the live demo driver.
const demo = !!process.env.DEMO;

export default defineConfig({
  testDir: './e2e',
  timeout: demo ? 10 * 60 * 1000 : 2 * 60 * 1000,
  expect: { timeout: 20 * 1000 },
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:5173',
    headless: !demo,
    // LocalStack's certificate has no SAN for *.appsync-realtime-api.localhost.localstack.cloud (GAPS.md).
    ignoreHTTPSErrors: true,
    launchOptions: { slowMo: demo ? 500 : 0 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: demo ? 'on' : 'off',
  },
  // The frontend reads frontend/.env, written by scripts/frontend-env.sh.
  webServer: {
    command: 'npm --prefix ../frontend run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
