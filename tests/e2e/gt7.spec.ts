// Real browser WebSocket (subprotocol negotiation, Origin) against the in-process MOCK gt7.inputs.v1 collector.
// MOCK only: not evidence of the real collector or of GT7 (docs/validation-log.md).
import { expect, test } from '@playwright/test';
import type { MockCollector, MockCollectorOptions } from '../mock-collector/server.mjs';

// Dynamic import: Playwright loads specs as CJS, and the mock is ESM (uses import.meta).
const startMockCollector = async (o: MockCollectorOptions) => (await import('../mock-collector/server.mjs')).startMockCollector(o);

const PAGE_ORIGIN = 'http://localhost:4173';
let mock: MockCollector | undefined;
test.afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function connect(page: import('@playwright/test').Page, url: string) {
  await page.goto('/');
  await page.getByLabel(/GT7\s+collector/).check();
  await page.getByLabel('Collector URL').fill(url);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
}

test('GT7: negotiates gt7.inputs.v1 with the MOCK collector and shows live brake/throttle, steering unavailable', async ({ page }) => {
  mock = await startMockCollector({ port: 0, origins: [PAGE_ORIGIN] });
  await connect(page, mock.url);
  const panel = page.getByRole('region', { name: 'GT7 collector' });
  await expect(panel.locator('strong').first()).toHaveText('live');
  await expect(panel).toContainText('mock-0.3.0 (MOCK)');
  await expect(panel).toContainText('driver_steering_input_unverified');
  await expect(page.getByTestId('steering')).toHaveText('n/a');
  await expect(page.getByTestId('counters')).toHaveText(/frames [1-9]\d*/);
  expect(mock.received()).toBe(0); // read-only: the page never sends
});

test('GT7: an Origin the collector does not allow shows the exact --ws-origin to use', async ({ page }) => {
  mock = await startMockCollector({ port: 0, origins: ['http://localhost:5173'] });
  await connect(page, mock.url);
  await expect(page.getByRole('alert')).toContainText(`--ws-origin=${PAGE_ORIGIN} `);
});
