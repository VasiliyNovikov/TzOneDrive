import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Keep browser profiles and installation scratch space inside the workspace.
process.env.TMPDIR = path.resolve('tests/browser/.runtime');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('node_modules/.cache/playwright');
mkdirSync(process.env.TMPDIR, { recursive: true });
const port = Number(process.env.PORT || 4173);

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: 'tests/browser/.results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
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
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { HOST: '127.0.0.1', PORT: String(port), APP_ROOT: process.env.APP_ROOT || 'app' },
  },
});
