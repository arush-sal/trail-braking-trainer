// Performance measurements (spec 11.1: bundle size, cold-start load, CPU, memory, cross-language
// overhead) plus the proposed targets of spec 11.2. Headless Chromium, no hardware, MOCK input:
// numbers describe THIS machine only and are not product claims. Run via `make perf`.
// Needs both builds (`make build` for dist/ sizes, e2e-mode dist-e2e/ for the test hook).
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Proposed gross-regression budgets (docs/performance.md). Deliberately loose: they catch a 2-3x
// regression, not noise. Tighten only after measuring on target hardware.
export const BUDGET = { wasmBytes: 6 * 1024 * 1024, jsGzipBytes: 250 * 1024, heapGrowthBytes: 50 * 1024 * 1024 };

type Latency = { count: number; p50: number; p95: number; max: number };
type Hook = {
  snapshot: () => { state: string } | null;
  audio: () => { state: string; updates: number; alertsScheduled: number; latency: Latency; alertLatency: Latency };
};
declare global {
  interface Window { __tbtTest?: Hook; __longTasks?: number[] }
}

const DIST = 'apps/web/dist';
const ROUNDS = 8;
const report: Record<string, unknown> = {};
const save = () => {
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/perf.json', `${JSON.stringify(report, null, 2)}\n`);
};
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const round = (n: number, d = 1) => Number(n.toFixed(d));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const size = (paths: string[]) => {
  const bufs = paths.map((p) => readFileSync(p));
  return { files: paths.length, bytes: bufs.reduce((n, b) => n + b.length, 0), gzipBytes: bufs.reduce((n, b) => n + gzipSync(b).length, 0) };
};

async function heapUsed(cdp: CDPSession, gc: boolean) {
  if (gc) await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heap: m.JSHeapUsedSize!, task: m.TaskDuration!, script: m.ScriptDuration!, ts: m.Timestamp! };
}

async function coldStart(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('[data-testid=wasm-status]')?.textContent === 'ready', null, { timeout: 30_000 });
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const load = [...document.querySelectorAll('dt')].find((d) => d.textContent === 'Load time')?.nextElementSibling?.textContent ?? '';
    return { readyMs: performance.now(), domContentLoadedMs: nav.domContentLoadedEventEnd, loadMs: nav.loadEventEnd, wasmLoadMs: parseFloat(load) };
  });
}

test.describe.configure({ mode: 'serial' });

test('environment', async ({ browser }) => {
  report.environment = {
    label: 'headless Chromium, no hardware, MOCK input',
    browser: `Chromium ${browser.version()}`,
    os: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`,
  };
  save();
});

test('bundle sizes from the production build', () => {
  const all = files(DIST);
  const js = all.filter((p) => p.endsWith('.js'));
  const css = all.filter((p) => p.endsWith('.css'));
  const wasm = all.filter((p) => p.endsWith('.wasm'));
  report.bundle = { js: size(js), css: size(css), wasm: size(wasm) };
  save();
  expect(wasm.length).toBeGreaterThan(0);
});

test('cold start: navigation to WASM ready (3 fresh contexts)', async ({ browser }) => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext();
    runs.push(await coldStart(await ctx.newPage()));
    await ctx.close();
  }
  report.coldStart = {
    runs: runs.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v)]))),
    medianReadyMs: round(median(runs.map((r) => r.readyMs))),
    medianWasmLoadMs: round(median(runs.map((r) => r.wasmLoadMs))),
  };
  save();
});

test('cross-language overhead: validateFrame JS->Go->JS (existing benchmark button)', async ({ page }) => {
  await coldStart(page);
  await page.getByRole('button', { name: 'Run overhead benchmark' }).click();
  const text = (await page.getByTestId('wasm-bench').textContent())!;
  const m = /mean ([\d.]+) us, p95 ([\d.]+) us \(n=(\d+)\)/.exec(text);
  expect(m, text).not.toBeNull();
  report.crossLanguage = { meanUs: Number(m![1]), p95Us: Number(m![2]), n: Number(m![3]), note: 'p95 comes from a coarse (0.1-1 ms) browser timer' };
  save();
});

test(`representative ${ROUNDS}-round MOCK guided session: heap, CPU, long tasks, audio control-update latency`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__longTasks!.push(e.duration))).observe({ type: 'longtask', buffered: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');

  await coldStart(page);
  await page.getByRole('button', { name: 'Start mock input' }).click();
  await page.getByLabel(/MOCK: follow the drill target/).check();
  await page.getByRole('radio', { name: 'Guided' }).click({ timeout: 15_000 });
  await page.getByRole('combobox', { name: /^Drill/ }).selectOption({ label: 'Full trail brake (timed, B+S+T)' });
  await page.getByLabel('Rounds', { exact: true }).fill(String(ROUNDS));
  await page.getByLabel('Rest (s)').fill('1');
  await page.getByLabel('Countdown (s)').fill('1');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable session audio' }).click();
  await expect(page.getByTestId('session-audio')).toHaveText('running');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const longBefore = await page.evaluate(() => window.__longTasks!.length);
  const start = await heapUsed(cdp, true);
  const t0 = Date.now();
  await page.keyboard.press('g');
  const samples: number[] = [];
  for (;;) {
    const s = await page.evaluate(() => window.__tbtTest!.snapshot()?.state);
    if (s === 'COMPLETE') break;
    expect(['PREPARE', 'COUNTDOWN', 'ACTIVE', 'REST'], `unexpected state ${s}`).toContain(s);
    expect(Date.now() - t0).toBeLessThan(200_000);
    samples.push(round((await heapUsed(cdp, false)).heap / 1048576));
    await page.waitForTimeout(5000);
  }
  const wallMs = Date.now() - t0;
  const end = await heapUsed(cdp, false);
  const endGc = await heapUsed(cdp, true);
  const long = (await page.evaluate(() => window.__longTasks!)).slice(longBefore);
  const audio = await page.evaluate(() => window.__tbtTest!.audio());
  expect(audio.state).toBe('running');
  expect(audio.latency.count).toBeGreaterThan(100);

  const busy = (end.task - start.task) / (end.ts - start.ts);
  report.session = {
    rounds: ROUNDS,
    wallSeconds: round(wallMs / 1000),
    heapMiB: { startAfterGc: round(start.heap / 1048576), endBeforeGc: round(end.heap / 1048576), endAfterGc: round(endGc.heap / 1048576), samplesDuring: samples },
    heapGrowthBytes: Math.round(endGc.heap - start.heap),
    mainThread: { busyFraction: round(busy, 3), scriptFraction: round((end.script - start.script) / (end.ts - start.ts), 3) },
    longTasks: { count: long.length, totalMs: round(long.reduce((a, b) => a + b, 0)), maxMs: round(Math.max(0, ...long)) },
    audioControlUpdateMs: { count: audio.latency.count, p50: round(audio.latency.p50, 2), p95: round(audio.latency.p95, 2), max: round(audio.latency.max, 2), note: 'scene time -> parameter update scheduled; not acoustic latency' },
    alertScheduleMs: { count: audio.alertLatency.count, p50: round(audio.alertLatency.p50, 2), p95: round(audio.alertLatency.p95, 2), max: round(audio.alertLatency.max, 2) },
  };
  save();
});

test('soft budgets: fail only on gross regressions (proposed, see docs/performance.md)', () => {
  const r = report as { bundle?: { js: { gzipBytes: number }; wasm: { bytes: number } }; session?: { heapGrowthBytes: number } };
  expect(r.bundle, 'bundle test did not run').toBeTruthy();
  expect(r.session, 'session test did not run').toBeTruthy();
  expect(r.bundle!.wasm.bytes, 'WASM size').toBeLessThanOrEqual(BUDGET.wasmBytes);
  expect(r.bundle!.js.gzipBytes, 'JS gzip size').toBeLessThanOrEqual(BUDGET.jsGzipBytes);
  expect(r.session!.heapGrowthBytes, `JS heap growth over ${ROUNDS} rounds`).toBeLessThanOrEqual(BUDGET.heapGrowthBytes);
});
