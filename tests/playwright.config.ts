import { defineConfig, devices } from '@playwright/test';

// DEMO=1 runs headed and slowed down, so the smoke test doubles as the live demo driver.
const demo = !!process.env.DEMO;
// FRONTEND_URL points the test at a deployed frontend, for example the S3 website from
// scripts/deploy-frontend-s3.sh. Without it, the test starts the Vite dev server.
const frontendUrl = process.env.FRONTEND_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: demo ? 10 * 60 * 1000 : 2 * 60 * 1000,
  expect: { timeout: 20 * 1000 },
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: frontendUrl ?? 'http://localhost:5173',
    headless: !demo,
    // LocalStack's TLS certificate does not cover the AppSync Events realtime host yet.
    ignoreHTTPSErrors: true,
    launchOptions: { slowMo: demo ? 500 : 0 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: demo ? 'on' : 'off',
  },
  // The dev server reads frontend/.env, written by scripts/frontend-env.sh. It needs
  // EXTRA_CORS_ALLOWED_ORIGINS=http://localhost:5173 in .lstk/config.toml for the realtime socket.
  webServer: frontendUrl ? undefined : {
    command: 'npm --prefix ../frontend run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
