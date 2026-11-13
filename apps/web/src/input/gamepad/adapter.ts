import type { Axis, InputFrame, Measurement } from '../types';
import {
  applyRange, createRangeCapture, detectChange, normalize, setCenter,
  type Detected, type Mapping, type PadSnapshot, type RangeCapture,
} from './normalize';
import { createDeviceTracker, summarize, type Summary } from './stats';

/** Structural subset of the DOM Gamepad so tests can inject fakes. */
export type PadLike = {
  id: string; index: number; connected: boolean; mapping?: string; timestamp: number;
  axes: readonly number[]; buttons: readonly { value: number }[];
};
export type AdapterEvent = {
  type: 'source-lost' | 'source-restored' | 'source-ambiguous' | 'error';
  axis?: Axis;
  deviceId?: string; // for source-ambiguous: the gamepad.id that reconnected ambiguously (user must reselect)
  message?: string;
  atMs: number;
};
export type DeviceInfo = {
  key: string; id: string; index: number; mapping: string; timestamp: number;
  axes: number[]; buttons: number[]; hz: number; polls: number; duplicates: number;
};
export type Mappings = Partial<Record<Axis, Mapping>>;

export type AdapterOptions = {
  getGamepads: () => readonly (PadLike | null)[];
  onFrame?: (f: InputFrame) => void;
  onEvent?: (e: AdapterEvent) => void;
  now?: () => number;
  /** setInterval cadence. Also the only poller while hidden, so hidden behavior is measured. */
  intervalMs?: number;
  /** A poll interval above this is a gap (quality.gap). */
  gapMs?: number;
  /** requestAnimationFrame impl; null disables rAF (interval only). */
  raf?: ((cb: () => void) => number) | null;
  caf?: (id: number) => void;
  doc?: { visibilityState: string } & EventTarget;
  target?: EventTarget; // gamepadconnected/disconnected source (window)
};

export const AXES: Axis[] = ['brake', 'steering', 'throttle'];
const MAX_KEEP = 600;
const keep = <T,>(a: T[], v: T, n = MAX_KEEP) => { a.push(v); if (a.length > n) a.shift(); };

export function createGamepadAdapter(opts: AdapterOptions) {
  const now = opts.now ?? (() => performance.now());
  const intervalMs = opts.intervalMs ?? 16;
  const gapMs = opts.gapMs ?? 50;
  const raf = opts.raf === undefined ? (globalThis.requestAnimationFrame?.bind(globalThis) ?? null) : opts.raf;
  const caf = opts.caf ?? ((id: number) => globalThis.cancelAnimationFrame?.(id));
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const target = opts.target ?? (typeof window !== 'undefined' ? window : undefined);
  const hidden = () => doc?.visibilityState === 'hidden';

  const mappings: Mappings = {};
  const trackers = new Map<string, ReturnType<typeof createDeviceTracker>>();
  const captures = new Map<Axis, RangeCapture>();
  const lost = new Map<Axis, boolean>();
  const visIv: number[] = [];
  const hidIv: number[] = [];
  const gaps: { atMs: number; intervalMs: number; hidden: boolean }[] = [];
  const visibilityLog: { atMs: number; state: string }[] = [];
  const eventLog: AdapterEvent[] = [];
  let missedPolls = 0;
  let polls = 0;
  let last: number | null = null;
  let seq = 0;
  let devices: DeviceInfo[] = [];
  let byKey = new Map<string, PadLike>();
  let lastFrame: InputFrame | null = null;
  let detect: { baseline: PadSnapshot[]; cb: (d: Detected) => void } | null = null;
  let rafId: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let onFrame = opts.onFrame;

  // Stable identity: a connection keeps its ordinal while it stays at the same gamepad.index with the same id.
  // A new connection takes a freed ordinal only when exactly one is free; otherwise it is ambiguous and gets a
  // fresh ordinal (mapped channels stay unavailable until the user reselects). Never auto-remaps.
  const assigned = new Map<number, { id: string; ord: number }>();
  const known = new Map<string, Set<number>>();
  let pollError: string | null = null;

  /** Returns pads, or null if getGamepads threw (permissions policy, SecurityError, ...). */
  function connected(): PadLike[] | null {
    try {
      return opts.getGamepads().filter((p): p is PadLike => !!p && p.connected !== false);
    } catch (e) {
      const msg = e instanceof Error ? e.message || e.name : String(e);
      if (pollError !== msg) {
        const ev: AdapterEvent = { type: 'error', message: msg, atMs: now() };
        keep(eventLog, ev, 100);
        opts.onEvent?.(ev);
      }
      pollError = msg;
      return null;
    }
  }
  function keyed(pads: PadLike[]) {
    const live = new Set(pads.map((p) => p.index));
    for (const i of [...assigned.keys()]) if (!live.has(i)) assigned.delete(i);
    return [...pads].sort((a, b) => a.index - b.index).map((p) => {
      let a = assigned.get(p.index);
      if (!a || a.id !== p.id) {
        let ords = known.get(p.id);
        if (!ords) known.set(p.id, (ords = new Set()));
        const held = new Set([...assigned.values()].filter((x) => x.id === p.id).map((x) => x.ord));
        const free = [...ords].filter((o) => !held.has(o));
        const ord = free.length === 1 ? free[0]! : ords.size ? Math.max(...ords) + 1 : 0;
        if (free.length > 1) {
          const ev: AdapterEvent = { type: 'source-ambiguous', deviceId: p.id, atMs: now() };
          keep(eventLog, ev, 100);
          opts.onEvent?.(ev);
        }
        ords.add(ord);
        a = { id: p.id, ord };
        assigned.set(p.index, a);
      }
      return { key: `${p.id}#${a.ord}`, pad: p };
    });
  }
  const snapshots = (): PadSnapshot[] =>
    keyed(connected() ?? []).map(({ key, pad: p }) => ({ key, axes: [...p.axes], buttons: p.buttons.map((b) => b.value) }));

  function measure(axis: Axis, t: number): Measurement {
    const m = mappings[axis];
    const unit = m?.kind === 'button' ? 'gamepad-button' : 'gamepad-axis';
    const p = m && byKey.get(m.deviceId);
    const raw = m && p ? (m.kind === 'axis' ? p.axes[m.index] : p.buttons[m.index]?.value) : undefined;
    if (m) {
      const nowLost = raw === undefined;
      if (nowLost !== (lost.get(axis) ?? false)) {
        lost.set(axis, nowLost);
        const ev: AdapterEvent = { type: nowLost ? 'source-lost' : 'source-restored', axis, deviceId: m.deviceId, atMs: t };
        keep(eventLog, ev, 100);
        opts.onEvent?.(ev);
      }
    }
    if (!m || raw === undefined || !Number.isFinite(raw)) return { available: false, rawValue: null, rawUnit: unit, normalized: null };
    captures.get(axis)?.add(raw);
    const n = normalize(raw, m, axis);
    return { available: n !== null, rawValue: raw, rawUnit: unit, normalized: n, ...(m.calibrated ? { calibrationId: `user-${axis}` } : {}) };
  }

  function poll(timed = true) {
    const t = now();
    let gap = false;
    if (timed) {
      if (last !== null) {
        const dt = t - last;
        keep(hidden() ? hidIv : visIv, dt);
        if (dt > gapMs) {
          gap = true;
          missedPolls += Math.max(0, Math.round(dt / intervalMs) - 1);
          keep(gaps, { atMs: t, intervalMs: dt, hidden: hidden() }, 100);
        }
      }
      last = t;
      polls++;
    }
    const pads = connected();
    if (pads) pollError = null;
    const ks = pads ? keyed(pads) : []; // on error keep assignments so recovery does not look ambiguous
    byKey = new Map(ks.map(({ key, pad }) => [key, pad]));
    devices = ks.map(({ key, pad }) => {
      let tr = trackers.get(key);
      if (!tr) trackers.set(key, (tr = createDeviceTracker()));
      if (timed) tr.record(t, pad.timestamp);
      return {
        key, id: pad.id, index: pad.index, mapping: pad.mapping ?? '', timestamp: pad.timestamp,
        axes: [...pad.axes], buttons: pad.buttons.map((b) => b.value), ...tr.stats(t),
      };
    });
    if (detect) {
      const hit = detectChange(detect.baseline, snapshots());
      if (hit) {
        const { cb } = detect;
        detect = null;
        cb(hit);
      }
    }
    const [brake, steering, throttle] = [measure('brake', t), measure('steering', t), measure('throttle', t)];
    const used = AXES.filter((a) => mappings[a] && [brake, steering, throttle][AXES.indexOf(a)]!.available);
    // Emit every poll: Chrome only updates `timestamp` on change, so steady pedals must still produce samples.
    lastFrame = {
      schemaVersion: 1, source: 'gamepad',
      sourceId: [...new Set(AXES.map((a) => mappings[a]?.deviceId).filter(Boolean))].join('+') || 'gamepad',
      sequence: seq++, receivedMonoMs: t, brake, steering, throttle,
      quality: { gap, stale: false, calibrated: used.length > 0 && used.every((a) => mappings[a]!.calibrated === true) },
    };
    onFrame?.(lastFrame);
  }

  const loop = () => { rafId = raf!(loop); poll(); };
  const onVis = () => {
    keep(visibilityLog, { atMs: now(), state: doc!.visibilityState }, 200);
    if (running && raf && !hidden() && rafId === null) rafId = raf(loop);
  };
  const onPad = () => poll(false);

  return {
    start() {
      if (running) return;
      running = true;
      if (doc) keep(visibilityLog, { atMs: now(), state: doc.visibilityState }, 200);
      doc?.addEventListener('visibilitychange', onVis);
      target?.addEventListener('gamepadconnected', onPad);
      target?.addEventListener('gamepaddisconnected', onPad);
      if (raf) rafId = raf(loop);
      // Interval polls only when rAF is not driving (hidden tab or rAF disabled), so hidden cadence is measured.
      timer = setInterval(() => { if (!raf || hidden()) poll(); }, intervalMs);
    },
    stop() {
      running = false;
      doc?.removeEventListener('visibilitychange', onVis);
      target?.removeEventListener('gamepadconnected', onPad);
      target?.removeEventListener('gamepaddisconnected', onPad);
      if (rafId !== null) caf(rafId);
      rafId = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
    setMapping(axis: Axis, m: Mapping | null) {
      if (m) mappings[axis] = m; else delete mappings[axis];
      lost.delete(axis);
    },
    setOnFrame(fn: ((f: InputFrame) => void) | undefined) { onFrame = fn; },
    getMappings: (): Mappings => ({ ...mappings }),
    startRangeCapture(axis: Axis) { captures.set(axis, createRangeCapture()); },
    /** Applies the captured range (if any movement was seen). Returns whether it was applied. */
    stopRangeCapture(axis: Axis) {
      const r = captures.get(axis)?.result();
      captures.delete(axis);
      const m = mappings[axis];
      if (!r || !m) return false;
      mappings[axis] = applyRange(m, r);
      return true;
    },
    isCapturing: (axis: Axis) => captures.has(axis),
    /** Sets steering center (or any axis' center) from the current raw value. */
    setCenterFromCurrent(axis: Axis) {
      const m = mappings[axis];
      const raw = lastFrame?.[axis].rawValue;
      if (!m || raw === null || raw === undefined) return false;
      mappings[axis] = setCenter(m, raw);
      return true;
    },
    /** "Move the control now": compares live values to a baseline taken now; fires once. Returns cancel. */
    startDetect(cb: (d: Detected) => void) {
      const mine = { baseline: snapshots(), cb };
      detect = mine;
      return () => { if (detect === mine) detect = null; };
    },
    snapshot: () => ({ devices, frame: lastFrame, mappings: { ...mappings } }),
    stats: () => ({
      polls, missedPolls,
      visibleIntervals: summarize(visIv) as Summary,
      hiddenIntervals: summarize(hidIv) as Summary,
      gaps: [...gaps],
      visibilityLog: [...visibilityLog],
      events: [...eventLog],
      error: pollError,
    }),
  };
}
export type GamepadAdapter = ReturnType<typeof createGamepadAdapter>;
