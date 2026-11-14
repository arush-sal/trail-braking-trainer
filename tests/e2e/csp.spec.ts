import { readFileSync, statSync } from 'node:fs';
import { WEBKIT_CSP } from './browsers';
import { extname, join, normalize } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Serves the PRODUCTION bundle (apps/web/dist, built by `make test-e2e`) with the headers from
// apps/web/public/_headers applied the way Cloudflare does (every matching rule; "/x/*" is a
// prefix), so the real CSP is enforced on the real bytes: app + Go WASM + Web Audio + results.
const DIST = join(process.cwd(), 'apps/web/dist'); // playwright runs from the repo root
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
};

function loadRules(): [string, Record<string, string>][] {
  const rules: [string, Record<string, string>][] = [];
  for (const line of readFileSync(join(DIST, '_headers'), 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push([line.trim(), {}]);
    else {
      const i = line.indexOf(':');
      rules.at(-1)![1][line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}
const headersFor = (rules: ReturnType<typeof loadRules>, path: string) =>
  Object.assign({}, ...rules.filter(([p]) => (p.endsWith('/*') ? path.startsWith(p.slice(0, -1)) : path === p)).map(([, h]) => h)) as Record<string, string>;

async function serveDist(page: Page, tweakCsp: (csp: string) => string = (c) => c) {
  const rules = loadRules();
  await page.route('http://localhost:4173/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    let file = join(DIST, normalize(path === '/' ? '/index.html' : path));
    try {
      if (!statSync(file).isFile()) throw new Error();
    } catch {
      file = join(DIST, 'index.html'); // SPA fallback, like Pages without a 404.html
    }
    const h = headersFor(rules, path);
    h['Content-Security-Policy'] = tweakCsp(h['Content-Security-Policy']!);
    return route.fulfill({ path: file, headers: { ...h, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' } });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
}
const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test('production bundle loads under the _headers CSP: WASM core and audio run; only the intended requests are blocked', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', WEBKIT_CSP);
  const consoleErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await serveDist(page);
  const res = await page.goto('/');
  expect(res!.headers()['content-security-policy']).toContain("'wasm-unsafe-eval'");
  await expect(page.getByTestId('wasm-version')).toHaveText(/^(?!--$)(?!error)\S.*/, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Enable session audio' }).click();
  await expect(page.getByTestId('session-audio')).toHaveText('running');
  expect(await violations(page)).toEqual([]);

  // connect-src: a collector WebSocket on loopback is allowed (the connection itself fails: nothing listens);
  // a third-party HTTP request is blocked by the policy before it reaches the network.
  const probe = await page.evaluate(async () => {
    let ws = 'allowed';
    try { new WebSocket('ws://127.0.0.1:9/v1/inputs').close(); } catch (e) { ws = (e as Error).name; }
    const http = await fetch('https://example.com/').then(() => 'fetched', () => 'blocked');
    return { ws, http };
  });
  expect(probe).toEqual({ ws: 'allowed', http: 'blocked' });
  await expect.poll(() => violations(page)).toEqual(['connect-src https://example.com/']);
  expect(consoleErrors.filter((t) => !/example\.com|127\.0\.0\.1:9/.test(t))).toEqual([]);
});

test('a MOCK session runs to the results graphs under the CSP without violations', async ({ page, browserName }) => {
  // WebKit (WPE): not re-verified since the Firefox main-thread stall fix (announcer voice cache); see docs/validation-log.md.
  test.skip(browserName === 'webkit', 'MOCK session too slow in this headless WebKit setup (not re-verified)');
  test.setTimeout(60_000);
  await serveDist(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start mock input' }).click();
  await page.getByRole('button', { name: 'Enable session audio' }).click();
  await page.getByLabel('Rounds', { exact: true }).fill('1');
  await page.getByLabel('Countdown (s)').fill('0');
  await page.getByLabel('Round length (s)').fill('1');
  await expect(page.getByRole('radio', { name: 'Guided' })).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('g');
  const results = page.getByRole('region', { name: 'Session results' });
  await expect(results).toBeVisible({ timeout: 20_000 });
  await expect(results.locator('path.actual').first()).toBeVisible(); // React inline styles (CSSOM) are allowed by style-src 'self'
  expect(await violations(page)).toEqual([]);
});

test('control: without wasm-unsafe-eval the same CSP blocks the Go core and the app says so', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', WEBKIT_CSP);
  await serveDist(page, (c) => c.replace(" 'wasm-unsafe-eval'", ''));
  await page.goto('/');
  await expect(page.getByTestId('wasm-status')).toHaveText('error', { timeout: 10_000 });
  await expect(page.getByRole('alert').first()).toContainText('The training core could not load');
  expect((await violations(page)).some((v) => v.startsWith('script-src') || v.startsWith('wasm'))).toBe(true);
});
