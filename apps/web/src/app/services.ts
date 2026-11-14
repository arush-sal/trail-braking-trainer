// Page-wide services: one audio engine, announcer, voice, binding set and gamepad command poll.
// Commands reach the session runner once the core has loaded (runnerRef).
import { SonifyEngine } from '../audio/sonify/SonifyEngine';
import type { AudioAlert } from '../audio/sonify/types';
import { createAnnouncer, type AnnouncerOptions } from '../audio/speech/announcer';
import { audioSuspended, commandRejected, confirmStop, micState } from '../audio/speech/phrases';
import type { CtxLike } from '../audio/synth/ToneEngine';
import type { LatencySummary } from '../audio/synth/mapping';
import { createBindings } from '../controls/bindings';
import { createVoice, type VoiceOptions } from '../controls/voice';
import type { Command, CommandSource, DispatchResult } from '../controls/dispatcher';
import { createGamepadAdapter, type AdapterOptions, type Mappings } from '../input/gamepad/adapter';
import type { InputFrame } from '../input/types';
import type { SessionEvent } from '../wasm/sessionBridge';
import type { RunnerOptions, SessionRunner } from '../features/session/sessionRunner';

const HOOK_MAX = 1000;
export type HookAlert = AudioAlert & { latencyMs: number; scheduled: boolean };
/** Test-only tap, compiled in only for the `--mode e2e` build. Arrays are bounded. */
export type TestHook = {
  phrases: string[]; alerts: HookAlert[]; events: SessionEvent[];
  snapshot: () => unknown;
  audio: () => { state: string; updates: number; alertsScheduled: number; latency: LatencySummary; alertLatency: LatencySummary };
};

export type ServicesOptions = AnnouncerOptions & {
  audioCtx?: () => CtxLike;
  voiceCtor?: VoiceOptions['ctor'];
  queryMic?: VoiceOptions['queryMic'];
  getGamepads?: AdapterOptions['getGamepads'];
  raf?: AdapterOptions['raf'];
};

export function createServices(o: ServicesOptions = {}) {
  const sonify = new SonifyEngine(o.audioCtx);
  const announcer = createAnnouncer({ synth: o.synth, createUtterance: o.createUtterance });
  const runnerRef: { current: SessionRunner | null } = { current: null };
  let trainingMaps: Mappings = {};
  const dispatch = (c: Command, s: CommandSource): DispatchResult => {
    if (runnerRef.current) return runnerRef.current.dispatcher.dispatch(c, s);
    announcer.say(commandRejected(c), { category: 'alerts' });
    return { ok: false, reason: 'not-allowed' };
  };
  const bindings = createBindings({
    dispatch,
    allowed: (c) => runnerRef.current?.allowed(c) ?? false,
    isTrainingInput: (d, kind, i) => Object.values(trainingMaps).some((m) => m?.deviceId === d && m.kind === kind && m.index === i),
  });
  const voice = createVoice({
    dispatch, ctor: o.voiceCtor, queryMic: o.queryMic,
    onEvent: (e) => { if (e.type === 'confirm-needed') announcer.say(confirmStop(), { priority: 'critical' }); },
  });

  // Eyes-free recovery cues (spec 8): voice failures and lost session audio are spoken, not only shown.
  // Speech output does not go through the AudioContext, so it is still heard while that is suspended.
  let micWas = voice.status;
  voice.subscribe(() => {
    const s = voice.status;
    if (s !== micWas && (s === 'denied' || s === 'error' || s === 'network')) announcer.say(micState(s), { priority: 'critical' });
    micWas = s;
  });
  let audioWas = sonify.state;
  sonify.onState((s) => {
    if (audioWas === 'running' && (s === 'suspended' || s === 'closed')) announcer.say(audioSuspended(), { priority: 'critical' });
    audioWas = s;
  });

  // Command buttons work whatever the training source is: a separate, lightweight poll that
  // only runs while a button is bound or being learned. Same device keying as the Devices panel.
  const pads = createGamepadAdapter({
    getGamepads: o.getGamepads ?? (() => (typeof navigator !== 'undefined' && 'getGamepads' in navigator ? navigator.getGamepads() : [])),
    raf: o.raf,
  });
  pads.setOnFrame(() => bindings.pollButtons(pads.snapshot().devices));
  let polling = false;
  const syncPoll = () => {
    const need = bindings.list().buttons.length > 0 || bindings.state().learning?.kind === 'gamepad';
    if (need === polling) return;
    polling = need;
    if (need) pads.start(); else pads.stop();
  };
  /** Start watching bindings to run the command poll as needed; returns the cleanup. */
  const watchPads = () => {
    const off = bindings.subscribe(syncPoll);
    syncPoll();
    return () => { off(); polling = false; pads.stop(); };
  };

  let hook: TestHook | undefined;
  let trace: RunnerOptions['trace'];
  // MODE is replaced at build time, so a production bundle drops this block (checked by make test-e2e).
  if (import.meta.env.MODE === 'e2e') {
    const h: TestHook = {
      phrases: [], alerts: [], events: [],
      snapshot: () => runnerRef.current?.getSnapshot() ?? null,
      audio: () => ({ state: sonify.state, updates: sonify.latency.summary().count, alertsScheduled: sonify.alertLatency.summary().count, latency: sonify.latency.summary(), alertLatency: sonify.alertLatency.summary() }),
    };
    const keep = <T,>(a: T[], v: T) => { a.push(v); if (a.length > HOOK_MAX) a.shift(); };
    let scheduled = 0;
    trace = (t) => {
      if ('say' in t) keep(h.phrases, t.say);
      else if ('event' in t) keep(h.events, t.event);
      else {
        const n = sonify.alertLatency.summary().count; // grows only when the alert was scheduled on a live AudioContext
        keep(h.alerts, { ...t.alert, latencyMs: performance.now() - t.alert.atMs, scheduled: n > scheduled });
        scheduled = n;
      }
    };
    hook = h;
    (globalThis as unknown as { __tbtTest?: TestHook }).__tbtTest = h;
  }

  return {
    sonify, announcer, runnerRef, bindings, voice, hook, trace,
    pushFrame: (f: InputFrame) => runnerRef.current?.pushFrame(f),
    setTrainingMappings: (m: Mappings) => { trainingMaps = m; },
    watchPads,
  };
}
export type Services = ReturnType<typeof createServices>;
