import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:4173' },
  projects: [
    { name: 'chromium', testDir: 'tests/e2e', use: { browserName: 'chromium' } },
    { name: 'firefox', testDir: 'tests/e2e', use: { browserName: 'firefox' } },
    { name: 'webkit', testDir: 'tests/e2e', use: { browserName: 'webkit' } },
    // Perf measurements (`make perf`): Chromium only (CDP metrics), never part of the e2e matrix.
    { name: 'perf', testDir: 'tests/perf', use: { browserName: 'chromium' } },
  ],
  // Serves the e2e-mode bundle (test hooks enabled) that `make test-e2e` builds into dist-e2e;
  // `make test-dist` sets E2E_DIST=dist to gate the production bundle that gets released.
  webServer: { command: `npm run preview -w apps/web -- --port 4173 --strictPort --outDir ${process.env.E2E_DIST ?? 'dist-e2e'}`, url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
});
