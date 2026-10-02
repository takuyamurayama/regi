import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: 'browser',
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    launchOptions: { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
    screenshot: 'only-on-failure',
  },
  reporter: [['list'], ['json', { outputFile: resolve('.context/browser-results.json') }]],
  outputDir: resolve('.context/browser-output'),
});
