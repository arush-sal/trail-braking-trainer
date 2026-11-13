import { useEffect, useMemo, useState } from 'react';
import type { Axis, InputFrame } from '../../input/types';
import { MAX_GAIN } from '../../audio/synth/mapping';
import { ToneEngine, type EngineState } from '../../audio/synth/ToneEngine';

type Props = { getLatestFrame: () => InputFrame | null; engine?: ToneEngine };

export function AudioCheck({ getLatestFrame, engine: injected }: Props) {
  const engine = useMemo(() => injected ?? new ToneEngine(), [injected]);
  const [state, setState] = useState<EngineState>(engine.state);
  const [axis, setAxis] = useState<Axis>('brake');
  const [vol, setVol] = useState(engine.volume);
  const [muted, setMuted] = useState(false);
  const [stats, setStats] = useState(() => engine.latency.summary());

  useEffect(() => engine.onState(setState), [engine]);
  useEffect(() => () => { if (!injected) void engine.dispose(); }, [engine, injected]);

  // Drive audio from the latest frame; no React render per sample.
  useEffect(() => {
    const id = setInterval(() => {
      const f = getLatestFrame();
      if (f) engine.setFrame(f, axis);
      else engine.silence();
    }, 16);
    return () => {
      clearInterval(id);
      engine.silence();
    };
  }, [engine, axis, getLatestFrame]);

  useEffect(() => {
    const id = setInterval(() => setStats(engine.latency.summary()), 500);
    return () => clearInterval(id);
  }, [engine]);

  const lat = engine.audioLatency();
  const fmt = (n: number | null) => (n === null ? 'n/a' : `${n} ms`);
  return (
    <section aria-label="Audio check">
      <h2>Audio check</h2>
      <p>Prototype: pitch follows the selected input. Not the final sonification.</p>
      <button type="button" onClick={() => void engine.unlock()}>Enable audio</button>{' '}
      <button type="button" onClick={() => engine.playTestTone()} disabled={state === 'locked'}>Test tone</button>
      <p>Audio state: <strong data-testid="audio-state">{state}</strong></p>
      {(state === 'suspended' || state === 'closed') && (
        <p role="alert">Audio is {state}. Tap Enable audio again; the browser or OS may have interrupted it.</p>
      )}
      <label>Volume{' '}
        <input type="range" min={0} max={MAX_GAIN} step={0.01} value={vol}
          onChange={(e) => { const v = Number(e.target.value); setVol(v); engine.setVolume(v); }} />
      </label>{' '}
      <label><input type="checkbox" checked={muted} onChange={(e) => { setMuted(e.target.checked); engine.setMuted(e.target.checked); }} /> Mute</label>{' '}
      <label>Axis{' '}
        <select value={axis} onChange={(e) => setAxis(e.target.value as Axis)}>
          <option value="brake">brake</option>
          <option value="steering">steering</option>
          <option value="throttle">throttle</option>
        </select>
      </label>
      <h3>Control-update latency</h3>
      <p>Input frame received to audio parameter update scheduled. This is NOT acoustic end-to-end latency; that needs a manual loopback/recording test.</p>
      <dl>
        <dt>Samples</dt><dd>{stats.count}</dd>
        <dt>p50 / p95 / max</dt><dd>{stats.p50.toFixed(1)} / {stats.p95.toFixed(1)} / {stats.max.toFixed(1)} ms</dd>
        <dt>baseLatency</dt><dd>{fmt(lat.baseLatencyMs)}</dd>
        <dt>outputLatency</dt><dd>{fmt(lat.outputLatencyMs)}</dd>
      </dl>
    </section>
  );
}
