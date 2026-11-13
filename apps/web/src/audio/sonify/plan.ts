// Pure sonification planning: AudioScene -> per-voice parameters. No Web Audio here.
// ALL numeric constants below are PROPOSED defaults, to be tuned in listening tests with users.
import type { Axis } from '../../input/types';
import { positionToFreq } from '../synth/mapping';
import type { AlertKind, AudioScene } from './types';

export type VoiceId = Axis | 'target' | 'cue';
export const VOICE_IDS: readonly VoiceId[] = ['brake', 'steering', 'throttle', 'target', 'cue'];
const AXES: readonly Axis[] = ['brake', 'steering', 'throttle'];

export type VoiceParams = {
  freq: number | null; // null => silent (never 0 Hz)
  gain: number; // 0..1 relative, before master cap
  wave: 'sine' | 'triangle';
  partialRatio: number; // movement partial: 2 = rising, 0.5 = falling
  partialLevel: number; // 0..1 ~ |rate of change|
  roughDepth: number; // 0..1 ~ jitter (fast AM => audible roughness)
  pulseRate: number; // Hz, 0 = steady
  pulseDepth: number; // 0..1
};
export const SILENT: VoiceParams = { freq: null, gain: 0, wave: 'sine', partialRatio: 2, partialLevel: 0, roughDepth: 0, pulseRate: 0, pulseDepth: 0 };

export type SonifyConfig = {
  neutral: number; // rest zone (pedal value / |steering|) where position tone is silent; 0 disables
  neutralRelease: number; // hysteresis: stays on until below neutral*this
  defaultTolerance: number;
  toleranceRelease: number; // hysteresis: leaves tolerance at tol*this
  rateTau: number; // s, derivative smoothing
  rateDeadband: number; // units/s below which movement is "still"
  rateFull: number; // units/s for full movement-partial level
  roughTau: number; // s
  roughOnset: number; // residual (units/s) below which roughness is 0 (sensor quantization noise)
  roughFull: number; // residual for full depth
  deviationScale: number; // |delta| beyond tol at which pulse rate saturates
  pulseMinHz: number;
  pulseMaxHz: number;
  mergeSpan: number; // dual-tone: fully separate at this multiple of tolerance
  cueRange: number; // self-paced: end-state cue starts within this distance of terminal
  backgroundGain: number;
  targetGain: number;
  cueGain: number;
  terminalCueGain: number;
  deviationPositionGain: number; // primary position tone level while deviation pulses carry the message
};
export const DEFAULT_CONFIG: SonifyConfig = {
  neutral: 0.03, neutralRelease: 0.6, defaultTolerance: 0.05, toleranceRelease: 1.25,
  rateTau: 0.08, rateDeadband: 0.03, rateFull: 1, roughTau: 0.3, roughOnset: 0.15, roughFull: 1,
  deviationScale: 0.3, pulseMinHz: 1.5, pulseMaxHz: 10, mergeSpan: 3, cueRange: 0.4,
  backgroundGain: 0.2, targetGain: 0.8, cueGain: 0.8, terminalCueGain: 0.5, deviationPositionGain: 0.4,
};
export const ABOVE_HZ = 784; // delta > 0: higher pulses
export const BELOW_HZ = 330; // delta < 0: lower pulses
export const IN_TOL_HZ = 523.25; // steady, between the two
export const GAP_MS = 250; // longer than this between samples resets the movement tracker

export type Plan = {
  voices: Record<VoiceId, VoiceParams>;
  diag: {
    primary: Axis | null;
    beatHz: number | null;
    inTolerance: boolean | null;
    deviation: number | null; // signed actual - desired (timed guided-deviation only)
    terminalDistance: number | null; // signed actual - terminal (self-paced only)
    rate: Partial<Record<Axis, number>>;
    roughness: Partial<Record<Axis, number>>;
  };
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Smoothed derivative + residual roughness for one axis. */
class Movement {
  private t: number | null = null;
  private v = 0;
  rate = 0;
  rough = 0;
  push(v: number | null, t: number, c: SonifyConfig) {
    if (v === null || !Number.isFinite(v)) { this.t = null; this.rate = 0; this.rough = 0; return; }
    if (this.t === null || t - this.t > GAP_MS || t < this.t) { this.t = t; this.v = v; this.rate = 0; this.rough = 0; return; }
    const dt = (t - this.t) / 1000;
    if (dt <= 0) return; // duplicate frame
    const raw = (v - this.v) / dt;
    this.rate += (1 - Math.exp(-dt / c.rateTau)) * (raw - this.rate);
    this.rough += (1 - Math.exp(-dt / c.roughTau)) * (Math.abs(raw - this.rate) - this.rough);
    this.t = t; this.v = v;
  }
}

export class ScenePlanner {
  readonly cfg: SonifyConfig;
  private mv: Record<Axis, Movement> = { brake: new Movement(), steering: new Movement(), throttle: new Movement() };
  private gate: Record<string, boolean> = {};
  private tol: Record<string, boolean> = {};
  constructor(cfg: Partial<SonifyConfig> = {}) { this.cfg = { ...DEFAULT_CONFIG, ...cfg }; }

  /** Position -> Hz with rest-zone hysteresis. null if unavailable or at rest. */
  private freq(key: string, axis: Axis, value: number | null | undefined): number | null {
    if (value === undefined || value === null || !Number.isFinite(value)) { this.gate[key] = false; return null; }
    const mag = axis === 'steering' ? Math.abs(value) : value;
    const th = this.cfg.neutral * (this.gate[key] ? this.cfg.neutralRelease : 1);
    this.gate[key] = mag >= th && (axis === 'steering' || value >= 0);
    return this.gate[key] ? positionToFreq(value, axis, 0) : null;
  }
  private within(key: string, err: number, tol: number) {
    return (this.tol[key] = Math.abs(err) <= tol * (this.tol[key] ? this.cfg.toleranceRelease : 1));
  }
  private pulses(delta: number, tol: number, gain: number): VoiceParams {
    const c = this.cfg;
    const rate = c.pulseMinHz + (c.pulseMaxHz - c.pulseMinHz) * clamp01((Math.abs(delta) - tol) / c.deviationScale);
    return { ...SILENT, freq: delta > 0 ? ABOVE_HZ : BELOW_HZ, gain, wave: 'triangle', pulseRate: rate, pulseDepth: 1 };
  }

  plan(scene: AudioScene): Plan {
    const c = this.cfg;
    const voices = Object.fromEntries(VOICE_IDS.map((v) => [v, { ...SILENT }])) as Record<VoiceId, VoiceParams>;
    const diag: Plan['diag'] = { primary: scene.primary, beatHz: null, inTolerance: null, deviation: null, terminalDistance: null, rate: {}, roughness: {} };
    const p = scene.primary;
    const guided = scene.mode !== 'freeform';

    for (const axis of AXES) {
      const a = scene.actual[axis];
      this.mv[axis].push(a, scene.nowMs, c);
      const f = this.freq(axis, axis, a);
      if (f === null) continue;
      const v = voices[axis];
      v.freq = f;
      if (p !== null && p !== axis) { v.gain = c.backgroundGain; continue; } // quiet, no movement signal
      v.gain = guided && scene.mode === 'guided-deviation' && p === axis && scene.desired?.[axis] !== undefined ? c.deviationPositionGain : p === null ? c.backgroundGain : 1;
      const m = this.mv[axis];
      diag.rate[axis] = m.rate;
      diag.roughness[axis] = m.rough;
      if (Math.abs(m.rate) >= c.rateDeadband) { v.partialLevel = Math.min(1, Math.abs(m.rate) / c.rateFull); v.partialRatio = m.rate > 0 ? 2 : 0.5; }
      v.roughDepth = clamp01((m.rough - c.roughOnset) / (c.roughFull - c.roughOnset));
    }

    const a = p === null ? null : scene.actual[p];
    if (p === null || a === null || !Number.isFinite(a)) return { voices, diag };
    const tol = scene.tolerance?.[p] ?? c.defaultTolerance;

    if (scene.mode === 'guided-dual' && scene.desired?.[p] !== undefined) {
      const d = scene.desired[p];
      const ft = this.freq('target', p, d);
      diag.inTolerance = Math.abs(a - d) <= tol;
      if (ft !== null) {
        const fa = voices[p].freq;
        const s = clamp01((Math.abs(a - d) - tol) / ((c.mergeSpan - 1) * tol));
        const k = s * s * (3 - 2 * s); // smoothstep: merged inside tol, separate at mergeSpan*tol
        const f = fa === null ? ft : fa + (ft - fa) * k;
        voices.target = { ...SILENT, freq: f, gain: c.targetGain, wave: 'triangle' };
        diag.beatHz = fa === null ? null : Math.abs(f - fa);
      }
    } else if (scene.mode === 'guided-deviation' && scene.desired?.[p] !== undefined) {
      const delta = a - scene.desired[p];
      diag.deviation = delta;
      diag.inTolerance = this.within('dev', delta, tol);
      voices.cue = diag.inTolerance ? { ...SILENT, freq: IN_TOL_HZ, gain: c.cueGain * 0.75 } : this.pulses(delta, tol, c.cueGain);
    } else if (scene.mode === 'guided-selfpaced' && scene.terminal?.[p] !== undefined) {
      // End-state guidance only: distance to the FINAL value. scene.desired is deliberately never read here.
      const delta = a - scene.terminal[p];
      diag.terminalDistance = delta;
      diag.inTolerance = this.within('term', delta, tol);
      if (diag.inTolerance) voices.cue = { ...SILENT, freq: IN_TOL_HZ, gain: c.terminalCueGain };
      else if (Math.abs(delta) <= c.cueRange) {
        const closeness = 1 - (Math.abs(delta) - tol) / (c.cueRange - tol);
        voices.cue = { ...this.pulses(delta, tol, c.terminalCueGain), pulseRate: c.pulseMinHz + (c.pulseMaxHz - c.pulseMinHz) * clamp01(closeness) };
      }
    }
    return { voices, diag };
  }
}

export type AlertNote = { freq: number; atMs: number; durMs: number };
export type AlertSpec = { wave: OscillatorType; gain: number; notes: AlertNote[] };
const seq = (freqs: number[], dur: number, gap: number): AlertNote[] => freqs.map((freq, i) => ({ freq, atMs: i * (dur + gap), durMs: dur }));
// PROPOSED. Overlap: fast 3-note alternating triangle, loudest; others differ in contour/rhythm/timbre.
export const ALERT_SPECS: Record<AlertKind, AlertSpec> = {
  overlap: { wave: 'triangle', gain: 1, notes: seq([880, 660, 880], 90, 20) },
  fluctuation: { wave: 'sine', gain: 0.6, notes: seq([330, 330], 60, 60) },
  'source-lost': { wave: 'triangle', gain: 0.9, notes: seq([523, 392, 294], 160, 30) },
  'source-invalid': { wave: 'sine', gain: 0.8, notes: seq([220, 233], 220, 40) },
  'round-start': { wave: 'sine', gain: 0.7, notes: seq([523, 659], 120, 20) },
  'round-end': { wave: 'sine', gain: 0.7, notes: seq([659, 523], 120, 20) },
  'session-complete': { wave: 'sine', gain: 0.7, notes: seq([523, 659, 784, 1047], 130, 20) },
};
