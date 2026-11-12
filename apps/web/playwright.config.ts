import { defineConfig, devices } from '@playwright/test';

/**
 * Dashboard E2E against the dev server: the real API + the real engine, fed by a recording
 * (E2E_DATA=<run dir>) or by a seeded synthetic market (default, used in CI).
 * Build the web first: npm run build -w @cortex/web
 */
const PORT = Number(process.env.E2E_PORT ?? 8090);
const source = process.env.E2E_DATA ?? '--synthetic';

export default defineConfig({
  testDir: 'e2e',
  outputDir: '../../test-results/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // one shared engine: commands in one test change the state the next one sees
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: `npx tsx apps/api/src/dev/server.ts ${source} --port ${PORT} --web apps/web/dist --origin http://127.0.0.1:${PORT}`,
    cwd: '../..',
    url: `http://127.0.0.1:${PORT}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
