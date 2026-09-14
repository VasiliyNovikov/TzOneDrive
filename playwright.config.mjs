import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT || 4173);
const basePath = process.env.APP_BASE_PATH || '/';
const baseURL = `http://127.0.0.1:${port}${basePath}`;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true,
  },
  projects: [
    { name: 'chromium-tv-720p', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 } } },
    { name: 'chromium-tv-1080p', use: { browserName: 'chromium', viewport: { width: 1920, height: 1080 } } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: baseURL,
    reuseExistingServer: false,
    env: { HOST: '127.0.0.1', PORT: String(port), APP_ROOT: process.env.APP_ROOT || 'app', APP_BASE_PATH: basePath },
  },
});
