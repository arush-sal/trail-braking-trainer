// Shared environment helpers for audio engines (latency report, tab visibility).

/** baseLatency + outputLatency in ms; null ('unknown') if neither is reported. outputLatency fluctuates and may be unreliable. */
export function outputLatencyMs(c: { baseLatency?: number; outputLatency?: number } | null | undefined): number | null {
  const ok = (v?: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!c || (!ok(c.baseLatency) && !ok(c.outputLatency))) return null;
  return Math.round(((ok(c.baseLatency) ? c.baseLatency : 0) + (ok(c.outputLatency) ? c.outputLatency : 0)) * 1000);
}
export const fmtLatency = (ms: number | null) => (ms === null ? 'unknown' : `${ms} ms`);

/** Subset of Document used for visibility. */
export type VisibilityLike = {
  hidden: boolean;
  addEventListener(t: 'visibilitychange', fn: () => void): void;
  removeEventListener(t: 'visibilitychange', fn: () => void): void;
};

/** Tracks tab visibility. backgroundRisk: hidden tab may throttle main-thread input polling/audio updates (behavior unverified). */
export class VisibilityGuard {
  private fns = new Set<(risk: boolean) => void>();
  private on = () => { const r = this.backgroundRisk; this.fns.forEach((f) => f(r)); };
  constructor(private doc: VisibilityLike | null = typeof document === 'undefined' ? null : document) {
    doc?.addEventListener('visibilitychange', this.on);
  }
  get backgroundRisk() { return this.doc?.hidden === true; }
  subscribe(fn: (risk: boolean) => void) { this.fns.add(fn); return () => void this.fns.delete(fn); }
  dispose() { this.doc?.removeEventListener('visibilitychange', this.on); this.fns.clear(); }
}
