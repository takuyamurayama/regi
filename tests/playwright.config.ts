import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: 'browser',
  workers: 1,
  webServer: [
    {
      command: 'npm run build -w @regi/api && node apps/api/dist/apps/api/src/main.js',
      cwd: resolve('.'),
      url: 'http://localhost:3000/health',
      timeout: 120000,
      reuseExistingServer: !process.env.CI,
      env: { NODE_ENV: 'test', REGI_DEV_AUTH: 'true', PORT: '3000' },
    },
    {
      command: 'npm run dev -w @regi/web -- --host 127.0.0.1 --port 5173 --strictPort',
      cwd: resolve('.'),
      url: 'http://localhost:5173',
      timeout: 120000,
      reuseExistingServer: !process.env.CI,
    },
  ],
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    launchOptions: { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
    screenshot: 'only-on-failure',
  },
  reporter: [['list'], ['json', { outputFile: resolve('.context/browser-results.json') }]],
  outputDir: resolve('.context/browser-output'),
});
