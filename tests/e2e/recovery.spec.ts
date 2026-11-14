import { expect, test } from '@playwright/test';


// Spec 8 error recovery paths that need a real browser. Runs against the e2e-mode bundle.
type Hook = { phrases: string[] };
declare global {
  interface Window { __tbtTest?: Hook }
}

test('core.wasm fails to load: actionable alert, then Retry recovers without a reload', async ({ page }) => {
  await page.route('**/assets/core-*.wasm', (r) => r.abort('internetdisconnected'));
  await page.goto('/');
  const alert = page.getByRole('region', { name: 'Core status' }).getByRole('alert');
  await expect(alert).toContainText('The training core could not load', { timeout: 10_000 });
  await expect(alert).toContainText('Retry');
  await expect(page.getByTestId('wasm-status')).toHaveText('error');
  await expect(page.getByText(/Sessions need the training core/)).toBeVisible();
  // Input diagnostics still work without the core.
  await page.getByRole('button', { name: 'Start mock input' }).click();
  await expect(page.getByTestId('rate')).toHaveText(/^[1-9]\d* Hz$/);

  await page.unroute('**/assets/core-*.wasm');
  await page.getByRole('button', { name: 'Retry loading core' }).click();
  await expect(page.getByTestId('wasm-status')).toHaveText('ready', { timeout: 10_000 });
  await expect(page.getByRole('radio', { name: 'Guided' })).toBeVisible(); // session panel now available
  await expect(alert).toHaveCount(0);
});

test('app script fails to load (offline static resources): the boot message stays with a fix', async ({ page }) => {
  await page.route('**/assets/*.js', (r) => r.abort('internetdisconnected'));
  await page.goto('/');
  await expect(page.getByText(/If this message stays, the app's files did not load/)).toBeVisible();
  await expect(page.getByText(/Check your connection and reload the page/)).toBeVisible();
});

test('no gamepad connected: the source explains how to connect, and start is refused aloud with the reason', { tag: '@hooks' }, async ({ page, browserName }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: /Gamepad/ }).check();
  await expect(page.getByText(/No gamepads detected/)).toBeVisible();
  await expect(page.getByText(/press a pedal or button/)).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Guided' })).toBeVisible({ timeout: 15_000 }); // core ready
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('g');
  await expect(page.getByText(/Brake is not available from the current source.*map that control under Input devices/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__tbtTest!.phrases)).toContain('Cannot start. Brake not available from this source.');
  await expect(page.getByTestId('session-state')).toHaveText('IDLE');
});
