import { expect, test } from '@playwright/test';

test('app loads, mock input runs, WASM core reports a version, no third-party requests', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http')) origins.add(u.hostname);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Trail Braking Trainer', level: 1 })).toBeVisible();
  await expect(page.getByText('MOCK').first()).toBeVisible();

  await page.getByRole('button', { name: 'Start mock input' }).click();
  await expect(page.getByTestId('rate')).toHaveText(/^\d+ Hz$/);

  const version = page.getByTestId('wasm-version');
  await expect(version).toHaveText(/^(?!--$)(?!error)\S.*/, { timeout: 10_000 });

  await page.getByRole('button', { name: 'Run overhead benchmark' }).click();
  await expect(page.getByTestId('wasm-bench')).toContainText('mean');
  console.log(await page.getByTestId('wasm-bench').textContent(), '| load:', await page.getByText(/ ms$/).first().textContent());

  expect([...origins].filter((h) => h !== 'localhost' && h !== '127.0.0.1')).toEqual([]);
});
