import type { Axis } from '../../input/types';

export type AudioMode = 'freeform' | 'guided-dual' | 'guided-deviation' | 'guided-selfpaced';

/** Per-tick input. All values normalized: pedals [0,1], steering [-1,1]. null = unavailable (silence). */
export type AudioScene = {
  mode: AudioMode;
  primary: Axis | null;
  actual: Record<Axis, number | null>;
  /** Timed guided modes only. Ignored in freeform and self-paced (never fabricate a live desired). */
  desired?: Partial<Record<Axis, number>>;
  tolerance?: Partial<Record<Axis, number>>;
  /** Self-paced end-state only (final target value), not a moving reference. */
  terminal?: Partial<Record<Axis, number>>;
  nowMs: number;
};

export type AlertKind = 'overlap' | 'fluctuation' | 'source-lost' | 'source-invalid' | 'round-start' | 'round-end' | 'session-complete';
export type AudioAlert = { kind: AlertKind; atMs: number };
