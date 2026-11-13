export type Summary = { count: number; p50: number | null; p95: number | null; max: number | null };

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? null; // nearest-rank
}

export const summarize = (v: readonly number[]): Summary => ({
  count: v.length,
  p50: percentile(v, 50),
  p95: percentile(v, 95),
  max: v.length ? Math.max(...v) : null,
});

/** Per-device update tracker. Chrome only bumps `timestamp` when state changes, so Hz = rate of CHANGES. */
export function createDeviceTracker() {
  let changes: number[] = [];
  let lastTs: number | null = null;
  let polls = 0;
  let duplicates = 0;
  return {
    record(nowMs: number, timestamp: number) {
      polls++;
      if (lastTs !== null && timestamp === lastTs) duplicates++;
      else changes.push(nowMs);
      lastTs = timestamp;
    },
    stats(nowMs: number) {
      changes = changes.filter((t) => nowMs - t <= 1000);
      return { hz: changes.length, polls, duplicates };
    },
  };
}
