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

/**
 * Per-device update tracker. Gamepad.timestamp is platform-specific (per event, per report, per poll, or
 * unsupported), so changes are detected by comparing values with the previous poll. Timestamp is diagnostics only.
 */
export function createDeviceTracker() {
  let changes: number[] = [];
  let prev: readonly number[] | null = null;
  let polls = 0;
  let unchanged = 0;
  return {
    /** Returns whether any axis/button value changed since the previous poll (first poll counts as changed). */
    record(nowMs: number, values: readonly number[]): boolean {
      polls++;
      const changed = !prev || prev.length !== values.length || values.some((v, i) => v !== prev![i]);
      if (changed) changes.push(nowMs);
      else unchanged++;
      prev = [...values];
      return changed;
    },
    stats(nowMs: number) {
      changes = changes.filter((t) => nowMs - t <= 1000);
      return { hz: changes.length, polls, unchanged };
    },
  };
}
