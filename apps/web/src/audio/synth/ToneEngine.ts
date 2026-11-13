import type { Axis, InputFrame } from '../../input/types';
import { VisibilityGuard, outputLatencyMs, type VisibilityLike } from './env';
import { DEFAULT_GAIN, LatencyStats, clampGain, positionToFreq } from './mapping';

export type EngineState = 'locked' | 'running' | 'suspended' | 'closed';

/** Minimal AudioContext surface used here (injectable for tests). */
export type CtxLike = Pick<AudioContext, 'state' | 'currentTime' | 'destination' | 'resume' | 'close' | 'createOscillator' | 'createGain'> & {
  baseLatency?: number;
  outputLatency?: number;
  onstatechange: ((e?: Event) => void) | null;
};

const TC = 0.02; // glide time constant (s)

export class ToneEngine {
  readonly latency = new LatencyStats(2000);
  neutral = 0.03; // pedal rest zone; 0 disables
  private ctx: CtxLike | null = null;
  private osc: OscillatorNode | null = null;
  private env: GainNode | null = null;
  private master: GainNode | null = null;
  private vol = DEFAULT_GAIN;
  private muted = false;
  private toneUntil = 0;
  private lastFrame: InputFrame | null = null;
  private disposed = false;
  private listeners = new Set<(s: EngineState) => void>();

  private vis: VisibilityGuard;
  constructor(private factory: () => CtxLike = () => new AudioContext() as CtxLike, doc?: VisibilityLike) {
    this.vis = new VisibilityGuard(doc);
  }
  get backgroundRisk() { return this.vis.backgroundRisk; }
  onBackgroundRisk(fn: (risk: boolean) => void) { return this.vis.subscribe(fn); }
  get interrupted() { return (this.ctx?.state as string | undefined) === 'interrupted'; }

  get volume() { return this.vol; }
  get state(): EngineState {
    if (!this.ctx) return 'locked';
    const s = this.ctx.state as string;
    return s === 'running' ? 'running' : s === 'closed' ? 'closed' : 'suspended'; // 'interrupted' (iOS) => suspended
  }
  onState(fn: (s: EngineState) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit() { this.listeners.forEach((f) => f(this.state)); }

  /** Must be called from a user gesture. */
  async unlock() {
    if (!this.ctx) {
      const c = this.factory();
      c.onstatechange = () => this.emit();
      this.master = c.createGain();
      this.master.gain.value = this.muted ? 0 : this.vol;
      this.env = c.createGain();
      this.env.gain.value = 0;
      this.osc = c.createOscillator();
      this.osc.type = 'sine';
      this.osc.connect(this.env);
      this.env.connect(this.master);
      this.master.connect(c.destination);
      this.osc.start();
      this.ctx = c;
    }
    try { await this.ctx.resume(); } catch { /* Safari may throw while interrupted */ }
    this.emit();
  }

  private applyMaster() {
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol, this.ctx.currentTime, TC);
  }
  setVolume(v: number) { this.vol = clampGain(v); this.applyMaster(); }
  setMuted(m: boolean) { this.muted = m; this.applyMaster(); }

  silence() {
    if (performance.now() < this.toneUntil) return;
    if (this.ctx && this.env) this.env.gain.setTargetAtTime(0, this.ctx.currentTime, TC);
  }

  /** Drive pitch from a frame; records receivedMonoMs -> param-update latency. */
  setFrame(frame: InputFrame, axis: Axis) {
    if (!this.ctx || !this.osc || !this.env || performance.now() < this.toneUntil) return;
    const f = positionToFreq(frame[axis].normalized, axis, this.neutral);
    if (f === null) return this.silence();
    const t = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(f, t, TC);
    this.env.gain.setTargetAtTime(1, t, TC);
    if (frame !== this.lastFrame) {
      this.lastFrame = frame;
      this.latency.add(performance.now() - frame.receivedMonoMs);
    }
  }

  playTestTone() {
    if (!this.ctx || !this.osc || !this.env) return;
    this.toneUntil = performance.now() + 400;
    const t = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(440, t, 0.005);
    this.env.gain.setTargetAtTime(1, t, 0.005);
    this.env.gain.setTargetAtTime(0, t + 0.3, 0.02);
  }

  /** Stop and release everything. Idempotent. */
  async dispose() {
    if (this.disposed || !this.ctx) return;
    this.disposed = true;
    this.vis.dispose();
    this.osc?.stop();
    this.osc?.disconnect();
    this.env?.disconnect();
    this.master?.disconnect();
    await this.ctx.close();
    this.emit();
  }

  audioLatency() {
    const ms = (v?: number) => (typeof v === 'number' ? Math.round(v * 1000) : null);
    return { baseLatencyMs: ms(this.ctx?.baseLatency), outputLatencyMs: ms(this.ctx?.outputLatency), totalMs: outputLatencyMs(this.ctx) };
  }
}
