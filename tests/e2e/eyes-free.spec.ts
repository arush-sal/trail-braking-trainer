import { expect, test, type Page } from '@playwright/test';
import { FIREFOX_VOICE_DOM } from './browsers';

// Phase 3 "done when": a MOCK device completes a multi-round session eyes-free; overlap alerts
// immediately and the session continues; commands work from the keyboard without visible controls.
// Runs against the e2e-mode bundle (`make test-e2e`), the only build that carries window.__tbtTest.
type Hook = {
  phrases: string[];
  alerts: { kind: string; latencyMs: number; scheduled: boolean }[];
  events: { kind: string; to?: string; outcome?: string }[];
  snapshot: () => { state: string } | null;
  audio: () => { state: string; updates: number; alertsScheduled: number };
};
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

/** Screen-based setup (allowed by the spec), then focus is dropped: from here on only keys. */
async function setup(page: Page, drill: string, rounds: number, followOffset = 0) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start mock input' }).click();
  await page.getByLabel(/MOCK: follow the drill target/).check();
  if (followOffset) await page.getByRole('spinbutton', { name: 'offset' }).fill(String(followOffset));
  await page.getByRole('radio', { name: 'Guided' }).click({ timeout: 15_000 });
  await page.getByRole('combobox', { name: /^Drill/ }).selectOption({ label: drill });
  await page.getByLabel('Rounds', { exact: true }).fill(String(rounds));
  await page.getByLabel('Rest (s)').fill('1');
  await page.getByLabel('Countdown (s)').fill('1');
  await expect(page.getByRole('region', { name: 'Session', exact: true }).getByRole('alert')).toHaveCount(0); // drill accepted
  // Playwright's Firefox (speech-dispatcher) and WebKit builds on Linux report no local voice, so
  // spoken summaries are withheld by design until the user consents to network voices. Consent
  // there so the summary assertions run; Chromium keeps the default (local voices only).
  if (page.context().browser()?.browserType().name() !== 'chromium') await page.getByRole('checkbox', { name: /Allow network voices/ }).check();
  await page.getByRole('button', { name: 'Enable session audio' }).click();
  await expect(page.getByTestId('session-audio')).toHaveText('running');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

const state = (page: Page) => () => page.evaluate(() => window.__tbtTest!.snapshot()?.state);
const hook = (page: Page) => page.evaluate(() => ({ ...window.__tbtTest!, audio: window.__tbtTest!.audio() }));

test('eyes-free MOCK guided session: keyboard start, overlap alert, session completes', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', FIREFOX_VOICE_DOM);
  test.setTimeout(60_000);
  const foreign = trackOrigins(page);
  await setup(page, 'Full trail brake (timed, B+S+T)', 2);

  await page.keyboard.press('g');
  await expect.poll(state(page), { timeout: 10_000 }).toBe('ACTIVE');
  await page.waitForTimeout(1500); // into round 1
  const updatesBefore = (await hook(page)).audio.updates;
  await page.getByRole('button', { name: 'MOCK: inject overlap' }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(state(page), { timeout: 30_000 }).toBe('COMPLETE');

  const t = await hook(page);
  // Continuous audio was actually scheduled on a running AudioContext throughout the session.
  expect(t.audio.state).toBe('running');
  expect(t.audio.updates).toBeGreaterThan(updatesBefore + 100);
  // Exactly one overlap alert for one episode, scheduled on the AudioContext within 100 ms of the overlapping frame.
  expect(t.events.filter((e) => e.kind === 'overlapOnset')).toHaveLength(1);
  const overlap = t.alerts.filter((a) => a.kind === 'overlap');
  expect(overlap).toHaveLength(1);
  expect(overlap[0]!.scheduled).toBe(true);
  expect(overlap[0]!.latencyMs).toBeLessThan(100);
  expect(t.alerts.every((a) => a.scheduled)).toBe(true);
  expect(t.audio.alertsScheduled).toBe(t.alerts.length);
  // The overlap did not abort or invalidate the round.
  expect(t.events.filter((e) => e.kind === 'roundEnded').map((e) => e.outcome)).toEqual(['completedTimed', 'completedTimed']);
  expect(t.events.filter((e) => e.kind === 'stateChanged' && (e.to === 'ABORTED' || e.to === 'SOURCE_LOST'))).toEqual([]);
  expect(t.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(['round-start', 'round-end', 'session-complete']));
  // Spoken cues were issued (browser speech output itself is not verified here).
  expect(t.phrases[0]).toBe('Full trail brake. 2 rounds. 1 second rest.');
  expect(t.phrases).toEqual(expect.arrayContaining(['1', 'Go', expect.stringMatching(/^Round 1: completed\. Brake mean error \d/), expect.stringMatching(/^Round 2: completed\./)]));
  expect(t.phrases.at(-1)).toMatch(/^Session finished: 2 rounds, 2 completed\./);
  expect(t.phrases.filter((p) => p.length > 250)).toEqual([]); // spoken feedback stays short enough to hear
  expect(t.phrases.join(' ')).not.toMatch(/overlap/i);

  expect(foreign()).toEqual([]);
});

test('keyboard-only commands: pause, resume, complete (self-paced), skip, stop', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', FIREFOX_VOICE_DOM); // passes alone (2/2), flaky under 4 workers (1/3)
  test.setTimeout(60_000);
  const foreign = trackOrigins(page);
  // MOCK holds 0.3 above the 40% target, so auto-completion never fires; rounds end by command only.
  await setup(page, 'Self-paced 40% brake hold (self-paced, B)', 3, 0.3);
  const s = state(page);

  await page.keyboard.press('g');
  await expect.poll(s, { timeout: 10_000 }).toBe('ACTIVE');
  await page.keyboard.press('Space');
  await expect.poll(s).toBe('PAUSED');
  await page.keyboard.press('Space');
  await expect.poll(s).toBe('ACTIVE');
  await page.keyboard.press('Enter'); // complete round 1
  await expect.poll(s).toBe('REST');
  await expect.poll(s, { timeout: 10_000 }).toBe('ACTIVE');
  await page.keyboard.press('s'); // skip round 2
  await expect.poll(s).toBe('REST');
  await expect.poll(s, { timeout: 10_000 }).toBe('ACTIVE');
  await page.keyboard.press('Escape'); // stop in round 3
  await expect.poll(s).toBe('ABORTED');

  const t = await hook(page);
  expect(t.events.filter((e) => e.kind === 'roundEnded').map((e) => e.outcome)).toEqual(['completedManual', 'skipped', 'aborted']);
  expect(t.phrases).toEqual(expect.arrayContaining([expect.stringMatching(/^Round 1: completed\./), expect.stringMatching(/^Round 2: skipped\./), 'Session stopped.']));
  expect(t.phrases.filter((p) => p.startsWith('Cannot'))).toEqual([]);
  expect(foreign()).toEqual([]);
});

test('source loss mid-round invalidates the attempt (never completedTimed), is audible, and the round is retried', async ({ page, browserName }) => {
  test.skip(browserName === 'firefox', FIREFOX_VOICE_DOM);
  test.setTimeout(60_000);
  const foreign = trackOrigins(page);
  await setup(page, '40% brake hold (timed, B)', 1);
  const s = state(page);

  await page.keyboard.press('g');
  await expect.poll(s, { timeout: 10_000 }).toBe('ACTIVE');
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Stop mock input' }).click(); // the source goes silent
  await expect.poll(s).toBe('SOURCE_LOST');
  let t = await hook(page);
  expect(t.events.filter((e) => e.kind === 'roundEnded').map((e) => e.outcome)).toEqual(['invalidSourceLost']);
  expect(t.alerts.filter((a) => a.kind === 'source-lost' && a.scheduled)).toHaveLength(1);
  expect(t.phrases).toContain('Input source lost.');

  await page.getByRole('button', { name: 'Start mock input' }).click(); // source back: same round again
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(s, { timeout: 20_000 }).toBe('COMPLETE');
  t = await hook(page);
  expect(t.events.filter((e) => e.kind === 'roundEnded').map((e) => e.outcome)).toEqual(['invalidSourceLost', 'completedTimed']);
  expect(t.phrases).toContain('Input source restored.');
  expect(foreign()).toEqual([]);
});
