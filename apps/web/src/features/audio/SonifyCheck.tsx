import { useEffect, useMemo, useRef, useState } from 'react';
import type { Axis } from '../../input/types';
import { MAX_GAIN } from '../../audio/synth/mapping';
import { fmtLatency } from '../../audio/synth/env';
import type { EngineState } from '../../audio/synth/ToneEngine';
import { ALERT_SPECS } from '../../audio/sonify/plan';
import { SonifyEngine } from '../../audio/sonify/SonifyEngine';
import type { AlertKind, AudioMode, AudioScene } from '../../audio/sonify/types';

const MODES: AudioMode[] = ['freeform', 'guided-dual', 'guided-deviation', 'guided-selfpaced'];
type Motion = 'static' | 'smooth' | 'jittery';

/** Audition screen (audio setup, spec view 5). Mock values only; never real input. */
export function SonifyCheck({ engine: injected }: { engine?: SonifyEngine }) {
  const engine = useMemo(() => injected ?? new SonifyEngine(), [injected]);
  const [state, setState] = useState<EngineState>(engine.state);
  const [mode, setMode] = useState<AudioMode>('freeform');
  const [axis, setAxis] = useState<Axis>('brake');
  const [actual, setActual] = useState(0.5);
  const [desired, setDesired] = useState(0.5);
  const [terminal, setTerminal] = useState(1);
  const [motion, setMotion] = useState<Motion>('static');
  const [vol, setVol] = useState(engine.volume);
  const [muted, setMuted] = useState(false);
  const [ducked, setDucked] = useState(false);
  const live = useRef({ mode, axis, actual, desired, terminal, motion });
  useEffect(() => { live.current = { mode, axis, actual, desired, terminal, motion }; });

  const [bg, setBg] = useState(engine.backgroundRisk ?? false);
  useEffect(() => engine.onState(setState), [engine]);
  useEffect(() => engine.onBackgroundRisk?.(setBg), [engine]);
  useEffect(() => () => { if (!injected) void engine.dispose(); }, [engine, injected]);
  useEffect(() => {
    let tick = 0;
    const id = setInterval(() => {
      const s = live.current, now = performance.now();
      const wob = s.motion === 'static' ? 0 : 0.2 * Math.sin(now / 400) + (s.motion === 'jittery' ? (tick++ % 2 ? 0.03 : -0.03) : 0);
      const lo = s.axis === 'steering' ? -1 : 0;
      const a = Math.min(1, Math.max(lo, s.actual + wob));
      const scene: AudioScene = {
        mode: s.mode, primary: s.axis, nowMs: now,
        actual: { brake: null, steering: null, throttle: null, [s.axis]: a },
        desired: { [s.axis]: s.desired }, terminal: { [s.axis]: s.terminal },
      };
      engine.update(scene);
    }, 16);
    return () => { clearInterval(id); engine.silence(); };
  }, [engine]);

  const lo = axis === 'steering' ? -1 : 0;
  const slider = (label: string, v: number, set: (n: number) => void) => (
    <label>{label} {v.toFixed(2)}{' '}
      <input type="range" min={lo} max={1} step={0.01} value={v} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
  return (
    <section aria-label="Sonification check">
      <h2>Sonification check</h2>
      <p>Audition each mode with mock values. Proposed sounds, to be tuned in listening tests.</p>
      <button type="button" onClick={() => void engine.unlock()}>Enable audio</button>{' '}
      <span>Audio state: <strong>{state}</strong></span>
      {(state === 'suspended' || state === 'closed') && <p role="alert">Audio is {state}{engine.interrupted ? ' (interrupted by the browser or OS)' : ''}. Tap Enable audio again.</p>}
      {bg && <p role="status">Tab is hidden: audio and input updates may be throttled in background tabs (unverified). Keep this tab visible.</p>}
      <p>Output latency (base + output, as reported, not measured): {fmtLatency(engine.audioLatency?.().totalMs ?? null)}</p>
      <p>
        <label>Mode{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as AudioMode)}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>{' '}
        <label>Axis{' '}
          <select value={axis} onChange={(e) => setAxis(e.target.value as Axis)}>
            <option value="brake">brake</option><option value="steering">steering</option><option value="throttle">throttle</option>
          </select>
        </label>{' '}
        <label>Movement{' '}
          <select value={motion} onChange={(e) => setMotion(e.target.value as Motion)}>
            <option value="static">static</option><option value="smooth">smooth sweep</option><option value="jittery">jittery sweep</option>
          </select>
        </label>
      </p>
      <p>{slider('Actual', actual, setActual)}</p>
      {(mode === 'guided-dual' || mode === 'guided-deviation') && <p>{slider('Desired (timed only)', desired, setDesired)}</p>}
      {mode === 'guided-selfpaced' && (
        <>
          <p>{slider('Terminal (end state)', terminal, setTerminal)}</p>
          <p>Self-paced: no live desired-vs-actual delta exists. You hear position, movement and an end-state cue near the terminal value only.</p>
        </>
      )}
      <h3>Alerts</h3>
      <p>
        {(Object.keys(ALERT_SPECS) as AlertKind[]).map((k) => (
          <button key={k} type="button" onClick={() => engine.alert({ kind: k, atMs: performance.now() })}>{k}</button>
        ))}
      </p>
      <label><input type="checkbox" checked={ducked} onChange={(e) => { setDucked(e.target.checked); engine.duck(e.target.checked); }} /> Duck tones (simulates speech; alerts stay audible)</label>{' '}
      <label>Volume{' '}
        <input type="range" min={0} max={MAX_GAIN} step={0.01} value={vol} onChange={(e) => { const v = Number(e.target.value); setVol(v); engine.setVolume(v); }} />
      </label>{' '}
      <label><input type="checkbox" checked={muted} onChange={(e) => { setMuted(e.target.checked); engine.setMuted(e.target.checked); }} /> Mute</label>
    </section>
  );
}
