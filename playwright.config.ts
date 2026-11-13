import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:4173' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  // Serves the bundle built by `make build` (make test-e2e builds first).
  webServer: { command: 'npm run preview -w apps/web -- --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
});
