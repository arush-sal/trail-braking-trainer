// Web Audio realisation of ScenePlanner output. All musical decisions live in plan.ts.
import { DEFAULT_GAIN, LatencyStats, clampGain } from '../synth/mapping';
import { VisibilityGuard, outputLatencyMs, type VisibilityLike } from '../synth/env';
import type { CtxLike, EngineState } from '../synth/ToneEngine';
import { ALERT_SPECS, ScenePlanner, VOICE_IDS, type SonifyConfig, type VoiceId, type VoiceParams } from './plan';
import type { AudioAlert, AudioScene } from './types';

const TC = 0.02; // param glide (s)
const TC_FREQ = 0.015;
const DUCK_GAIN = 10 ** (-12 / 20); // -12 dB while speech plays
const DUCK_TC = 0.06;
const VOICE_SCALE = 0.5; // headroom: several voices may sum
const ALERT_BUS = 0.6;
const ROUGH_HZ = 40; // 30-70 Hz AM is perceived as roughness
const PARTIAL_MAX = 0.5;

type Voice = { osc: OscillatorNode; osc2: OscillatorNode; g2: GainNode; body: GainNode; rough: OscillatorNode; roughD: GainNode; pulse: GainNode; pul: OscillatorNode; pulD: GainNode; level: GainNode };

export class SonifyEngine {
  readonly latency = new LatencyStats(2000); // scene.nowMs -> parameter update scheduled
  readonly alertLatency = new LatencyStats(200); // alert.atMs -> alert scheduled
  readonly planner: ScenePlanner;
  private ctx: CtxLike | null = null;
  private master: GainNode | null = null;
  private duckNode: GainNode | null = null;
  private bus: GainNode | null = null;
  private voices = new Map<VoiceId, Voice>();
  private vol = DEFAULT_GAIN;
  private muted = false;
  private lastNow = NaN;
  private disposed = false;
  private listeners = new Set<(s: EngineState) => void>();

  private vis: VisibilityGuard;
  constructor(private factory: () => CtxLike = () => new AudioContext() as CtxLike, cfg: Partial<SonifyConfig> = {}, doc?: VisibilityLike) {
    this.planner = new ScenePlanner(cfg);
    this.vis = new VisibilityGuard(doc);
  }
  /** True when the tab is hidden: input polling/audio updates may be throttled (unverified). */
  get backgroundRisk() { return this.vis.backgroundRisk; }
  onBackgroundRisk(fn: (risk: boolean) => void) { return this.vis.subscribe(fn); }
  /** Safari 'interrupted': reported as 'suspended' by `state`; this flag lets the UI say so. */
  get interrupted() { return (this.ctx?.state as string | undefined) === 'interrupted'; }

  get volume() { return this.vol; }
  get state(): EngineState {
    if (!this.ctx) return 'locked';
    const s = this.ctx.state as string;
    return s === 'running' ? 'running' : s === 'closed' ? 'closed' : 'suspended';
  }
  onState(fn: (s: EngineState) => void) { this.listeners.add(fn); return () => void this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((f) => f(this.state)); }

  /** Must be called from a user gesture. */
  async unlock() {
    if (this.disposed) return;
    if (!this.ctx) {
      const c = this.factory();
      c.onstatechange = () => this.emit();
      const g = () => c.createGain();
      this.master = g(); this.master.gain.value = this.muted ? 0 : this.vol; this.master.connect(c.destination);
      this.duckNode = g(); this.duckNode.gain.value = 1; this.duckNode.connect(this.master);
      this.bus = g(); this.bus.gain.value = ALERT_BUS; this.bus.connect(this.master); // alerts bypass duck
      for (const id of VOICE_IDS) this.voices.set(id, this.makeVoice(c, this.duckNode));
      this.ctx = c;
    }
    try { await this.ctx.resume(); } catch { /* Safari may throw while interrupted; state stays suspended, UI offers retry */ }
    this.emit();
  }

  private makeVoice(c: CtxLike, out: GainNode): Voice {
    const o = () => c.createOscillator(), g = () => c.createGain();
    const v: Voice = { osc: o(), osc2: o(), g2: g(), body: g(), rough: o(), roughD: g(), pulse: g(), pul: o(), pulD: g(), level: g() };
    v.osc.connect(v.body); v.osc2.connect(v.g2); v.g2.connect(v.body);
    v.rough.frequency.value = ROUGH_HZ; v.rough.connect(v.roughD); v.roughD.connect(v.body.gain);
    v.pul.type = 'square'; v.pul.connect(v.pulD); v.pulD.connect(v.pulse.gain);
    v.body.connect(v.pulse); v.pulse.connect(v.level); v.level.connect(out);
    v.level.gain.value = 0; v.g2.gain.value = 0; v.roughD.gain.value = 0; v.pulD.gain.value = 0; v.body.gain.value = 1; v.pulse.gain.value = 1;
    for (const n of [v.osc, v.osc2, v.rough, v.pul]) n.start();
    return v;
  }

  private applyMaster() {
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol, this.ctx.currentTime, TC);
  }
  setVolume(v: number) { this.vol = clampGain(v); this.applyMaster(); }
  setMuted(m: boolean) { this.muted = m; this.applyMaster(); }

  /** Lower continuous tones while speech plays. Alerts are unaffected. */
  duck(on: boolean) {
    if (this.ctx && this.duckNode && !this.disposed) this.duckNode.gain.setTargetAtTime(on ? DUCK_GAIN : 1, this.ctx.currentTime, DUCK_TC);
  }

  private apply(v: Voice, p: VoiceParams, t: number) {
    if (p.freq === null || p.gain <= 0) { v.level.gain.setTargetAtTime(0, t, TC); return; }
    v.osc.type = v.osc2.type = p.wave;
    v.osc.frequency.setTargetAtTime(p.freq, t, TC_FREQ);
    v.osc2.frequency.setTargetAtTime(p.freq * p.partialRatio, t, TC_FREQ);
    v.g2.gain.setTargetAtTime(p.partialLevel * PARTIAL_MAX, t, TC);
    v.body.gain.setTargetAtTime(1 - p.roughDepth / 2, t, TC);
    v.roughD.gain.setTargetAtTime(p.roughDepth / 2, t, TC);
    const pd = p.pulseRate > 0 ? p.pulseDepth : 0;
    v.pul.frequency.setTargetAtTime(Math.max(p.pulseRate, 0.1), t, TC);
    v.pulse.gain.setTargetAtTime(1 - pd / 2, t, TC);
    v.pulD.gain.setTargetAtTime(pd / 2, t, TC);
    v.level.gain.setTargetAtTime(p.gain * VOICE_SCALE, t, TC);
  }

  /** Call every audio tick (~60 Hz). */
  update(scene: AudioScene) {
    if (!this.ctx || this.disposed) return;
    const plan = this.planner.plan(scene);
    const t = this.ctx.currentTime;
    for (const id of VOICE_IDS) this.apply(this.voices.get(id)!, plan.voices[id], t);
    if (scene.nowMs !== this.lastNow) { this.lastNow = scene.nowMs; this.latency.add(performance.now() - scene.nowMs); }
  }

  /** One-shot alert, scheduled immediately; not affected by duck. */
  alert(a: AudioAlert) {
    if (!this.ctx || !this.bus || this.disposed) return;
    const c = this.ctx, spec = ALERT_SPECS[a.kind], t0 = c.currentTime;
    for (const n of spec.notes) {
      const osc = c.createOscillator(), env = c.createGain();
      const s = t0 + n.atMs / 1000, e = s + n.durMs / 1000;
      osc.type = spec.wave;
      osc.frequency.value = n.freq;
      env.gain.setValueAtTime(0, s);
      env.gain.linearRampToValueAtTime(spec.gain, s + 0.005);
      env.gain.setValueAtTime(spec.gain, Math.max(s + 0.005, e - 0.02));
      env.gain.linearRampToValueAtTime(0, e);
      osc.connect(env); env.connect(this.bus);
      osc.onended = () => { osc.disconnect(); env.disconnect(); };
      osc.start(s); osc.stop(e + 0.02);
    }
    this.alertLatency.add(performance.now() - a.atMs);
  }

  silence() {
    if (!this.ctx) return;
    for (const v of this.voices.values()) v.level.gain.setTargetAtTime(0, this.ctx.currentTime, TC);
  }

  async dispose() {
    if (this.disposed || !this.ctx) return;
    this.disposed = true;
    this.vis.dispose();
    for (const v of this.voices.values()) for (const n of [v.osc, v.osc2, v.rough, v.pul]) { n.stop(); n.disconnect(); }
    this.master?.disconnect(); this.duckNode?.disconnect(); this.bus?.disconnect();
    await this.ctx.close();
    this.emit();
  }

  audioLatency() {
    const ms = (v?: number) => (typeof v === 'number' ? Math.round(v * 1000) : null);
    return { baseLatencyMs: ms(this.ctx?.baseLatency), outputLatencyMs: ms(this.ctx?.outputLatency), totalMs: outputLatencyMs(this.ctx) };
  }
}
