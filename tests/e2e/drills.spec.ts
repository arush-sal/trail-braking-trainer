import { expect, test, type Page } from '@playwright/test';
import { FIREFOX_PW_CRASH } from './browsers';

// Phase 4 "done when": hold, full-range sweep, progressive and multi-stage guided sessions run end
// to end with the MOCK following the target, and the results graph actual vs desired for every
// selected channel with numeric accuracy; self-paced timing and freeform accuracy are N/A.
// Runs against the e2e-mode bundle (`make test-e2e`).
type Hook = { snapshot: () => { state: string } | null };
declare global {
  interface Window { __tbtTest?: Hook }
}

function trackOrigins(page: Page) {
  const origins = new Set<string>();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http')) origins.add(u.hostname);
  });
  return () => [...origins].filter((h) => h !== 'localhost' && h !== '127.0.0.1');
}

const state = (page: Page) => () => page.evaluate(() => window.__tbtTest!.snapshot()?.state);

/** follow: MOCK tracks the drill target exactly (noise 0) plus `offset` (fraction of travel). */
async function begin(page: Page, follow: boolean, offset = 0) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start mock input' }).click();
  if (follow) {
    await page.getByLabel(/MOCK: follow the drill target/).check();
    await page.getByRole('spinbutton', { name: 'noise' }).fill('0');
    await page.getByRole('spinbutton', { name: 'offset' }).fill(String(offset));
  }
  await expect(page.getByRole('radio', { name: 'Guided' })).toBeVisible({ timeout: 15_000 });
}

async function run(page: Page) {
  await page.getByLabel('Rounds', { exact: true }).fill('1');
  await page.getByLabel('Countdown (s)').fill('0');
  await expect(page.getByRole('region', { name: 'Session', exact: true }).getByRole('alert')).toHaveCount(0); // drill accepted (other alerts, e.g. slow input, are environment warnings)
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('g');
  await expect.poll(state(page), { timeout: 20_000 }).toBe('COMPLETE');
  const results = page.getByRole('region', { name: 'Session results' });
  await expect(results).toBeVisible();
  return results;
}

const metricSection = (page: Page, title: string) =>
  page.getByRole('region', { name: 'Session results' }).locator('section', { has: page.getByRole('heading', { name: title, exact: true }) });

/** Numeric value of a metric row in the given results column (0 = first round/attempt). */
async function metric(page: Page, title: string, row: RegExp, col = 0): Promise<number> {
  const cell = metricSection(page, title).getByRole('row', { name: row }).getByRole('cell').nth(col);
  await expect(cell).toHaveText(/^-?\d+(\.\d+)? pp/);
  return parseFloat((await cell.textContent())!);
}
const mae = (a: string) => new RegExp(`^Mean absolute error.*\\(${a}\\)`);
const bias = (a: string) => new RegExp(`^Bias.*\\(${a}\\)`);

const TIMED: { id: string; type: string; controls: string[] }[] = [
  { id: 'hold-brake-40', type: 'hold', controls: ['brake'] },
  { id: 'sweep-brake-up', type: 'sweep', controls: ['brake'] },
  { id: 'prog-smooth', type: 'progressive', controls: ['brake'] },
  { id: 'stage-direct', type: 'multistage', controls: ['brake', 'steering', 'throttle'] },
];

for (const d of TIMED) {
  test(`timed ${d.type} (${d.id}): completes and graphs desired vs actual for every selected channel`, async ({ page }) => {
    test.setTimeout(60_000);
    const foreign = trackOrigins(page);
    await begin(page, true);
    await page.getByRole('radio', { name: 'Guided' }).click();
    await page.getByRole('combobox', { name: /^Drill/ }).selectOption(d.id);
    await run(page);
    for (const a of d.controls) {
      await expect(page.getByTestId(`path-${a}-desired`).first()).toHaveAttribute('d', /^M[\d.]/);
      await expect(page.getByTestId(`path-${a}-actual`).first()).toHaveAttribute('d', /^M[\d.]/);
    }
    // The MOCK tracks the target exactly, so every selected channel must be accurate (not just numeric).
    for (const a of d.controls) expect(await metric(page, 'Accuracy', mae(a)), `${a} MAE`).toBeLessThan(5);
    expect(foreign()).toEqual([]);
  });
}

test('a constant +10 pp MOCK offset is measured as ~10 pp mean error with a positive bias', async ({ page }) => {
  test.setTimeout(60_000);
  await begin(page, true, 0.1);
  await page.getByRole('radio', { name: 'Guided' }).click();
  await page.getByRole('combobox', { name: /^Drill/ }).selectOption('hold-brake-40');
  await run(page);
  const m = await metric(page, 'Accuracy', mae('brake'));
  expect(m).toBeGreaterThan(8);
  expect(m).toBeLessThan(12);
  expect(await metric(page, 'Accuracy', bias('brake'))).toBeGreaterThan(8);
});

test('a source gap mid-round marks that attempt invalid; the retried attempt is scored', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', FIREFOX_PW_CRASH);
  test.setTimeout(60_000);
  await begin(page, true);
  await page.getByRole('radio', { name: 'Guided' }).click();
  await page.getByRole('combobox', { name: /^Drill/ }).selectOption('hold-brake-40');
  await page.getByLabel('Rounds', { exact: true }).fill('1');
  await page.getByLabel('Countdown (s)').fill('0');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('g');
  await expect.poll(state(page), { timeout: 10_000 }).toBe('ACTIVE');
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Stop mock input' }).click();
  await expect.poll(state(page)).toBe('SOURCE_LOST');
  await page.getByRole('button', { name: 'Start mock input' }).click();
  await expect.poll(state(page), { timeout: 20_000 }).toBe('COMPLETE');
  const rounds = page.getByRole('region', { name: 'Session results' }).getByRole('combobox', { name: 'Round' }).locator('option');
  // Under CPU load a further >100 ms frame gap can invalidate a retry too; every attempt but the last must be invalid.
  const labels = await rounds.allTextContents();
  expect(labels[0]).toBe('Round 1, attempt 1 - invalidSourceLost');
  expect(labels.slice(0, -1).every((l) => l.endsWith('invalidSourceLost'))).toBe(true);
  expect(labels.at(-1)).toMatch(/^Round 1, attempt \d - completedTimed$/);
  expect(await metric(page, 'Accuracy', mae('brake'), labels.length - 1)).toBeLessThan(5); // only the completed attempt is scored
});

test('self-paced hold completes automatically and reports timing as N/A', async ({ page }) => {
  test.setTimeout(60_000);
  const foreign = trackOrigins(page);
  await begin(page, true);
  await page.getByRole('radio', { name: 'Guided' }).click();
  await page.getByRole('combobox', { name: /^Drill/ }).selectOption('hold-brake-40-sp');
  await run(page);
  await expect(metricSection(page, 'Timing').getByRole('cell').first()).toHaveText(/^N\/A/);
  expect(foreign()).toEqual([]);
});

test('freeform session reports accuracy as N/A', async ({ page }) => {
  test.setTimeout(60_000);
  const foreign = trackOrigins(page);
  await begin(page, false);
  await page.getByLabel('Round length (s)').fill('2');
  await run(page);
  await expect(page.getByTestId('path-brake-actual').first()).toHaveAttribute('d', /^M[\d.]/);
  await expect(metricSection(page, 'Accuracy').getByRole('cell').first()).toHaveText(/^N\/A/);
  expect(foreign()).toEqual([]);
});
