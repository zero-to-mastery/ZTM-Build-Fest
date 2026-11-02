import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4321);
// Locally, reuse the installed Chrome when Playwright's bundled browser is absent.
const channel = process.env.E2E_CHANNEL || undefined;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  // Parallel runs (several agents, or CI shards) each need their own artifacts.
  outputDir: process.env.E2E_OUTPUT || 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, channel } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, channel } },
    // The same journeys with a wide fallback font, as on Linux without Inter or Segoe UI.
    { name: 'desktop-wide-font', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, channel, wideFont: true } },
    { name: 'mobile-wide-font', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, channel, wideFont: true } },
  ],
  webServer: {
    command: 'node e2e/support/server.mjs',
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(port) },
  },
});
