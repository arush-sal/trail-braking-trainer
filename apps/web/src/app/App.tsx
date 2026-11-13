import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { followValues, startMockSource } from '../input/mock/mockSource';
import type { InputFrame } from '../input/types';
import { DevicesPanel } from '../features/devices/DevicesPanel';
import { AudioCheck } from '../features/audio/AudioCheck';
import { SonifyCheck } from '../features/audio/SonifyCheck';
import { ControlsPanel } from '../features/controls/ControlsPanel';
import { SessionPanel } from '../features/session/SessionPanel';
import { createSessionRunner, type SessionRunner } from '../features/session/sessionRunner';
import { WasmStatus } from '../wasm/WasmStatus';
import { coreBridge } from '../wasm/coreBridge';
import { createSessionBridge, type SessionBridge } from '../wasm/sessionBridge';
import { createServices } from './services';
import { Gt7Panel } from '../input/gt7/Gt7Panel';

const VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';
const DISPLAY_MS = 100; // ~10 Hz display refresh; samples never trigger renders
// A frame older than this is treated as no input (source stopped/lost), so audio
// and readout never present stale values as live (spec 4.4). ponytail: fixed
// threshold; tune from hardware poll-rate evidence.
const STALE_MS = 250;

type SourceKind = 'mock' | 'gamepad' | 'gt7';
const OVERLAP_MS = 400; // MOCK injected overlap episode length

type View = { brake: number | null; steering: number | null; throttle: number | null; hz: number };
// Unavailable channels stay null and render as n/a, never 0 (spec 4.1).
const pct = (v: number | null) => (v === null ? null : Math.round(v * 100));
const show = (v: number | null, signed = false) =>
  v === null ? 'n/a' : `${signed && v > 0 ? '+' : ''}${v}%`;

export function App() {
  const [source, setSource] = useState<SourceKind>('mock');
  const [mockRunning, setMockRunning] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [svc] = useState(() => createServices());
  const [session, setSession] = useState<{ runner: SessionRunner; bridge: SessionBridge } | null>(null);
  const [follow, setFollow] = useState({ on: false, offset: 0, noise: 0.02 });
  const followRef = useRef(follow);
  const overlapUntil = useRef(0);
  const audioState = useSyncExternalStore(
    (cb) => svc.sonify.onState(cb),
    () => svc.sonify.state,
  );
  useEffect(() => {
    followRef.current = follow;
  });
  // Single ingestion boundary: every source writes here; consumers read it.
  const latest = useRef<InputFrame | null>(null);
  const count = useRef(0);
  const onFrame = useCallback(
    (f: InputFrame) => {
      latest.current = f;
      count.current++;
      svc.pushFrame(f);
    },
    [svc],
  );

  useEffect(() => svc.bindings.attach(window), [svc]);
  useEffect(() => svc.watchPads(), [svc]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    coreBridge
      .load()
      .then((core) => {
        if (cancelled) return;
        const bridge = createSessionBridge(core.api);
        const runner = createSessionRunner({
          bridge, sonify: svc.sonify, announcer: svc.announcer, voice: svc.voice,
          trace: svc.trace,
        });
        svc.runnerRef.current = runner;
        setSession({ runner, bridge });
        off = () => {
          runner.dispose();
          bridge.dispose();
          svc.runnerRef.current = null;
        };
      })
      .catch(() => undefined); // shown by WasmStatus
    return () => {
      cancelled = true;
      off?.();
    };
  }, [svc]);
  const getLatestFrame = useCallback(() => {
    const f = latest.current;
    return f && performance.now() - f.receivedMonoMs <= STALE_MS ? f : null;
  }, []);
  const selectSource = (k: SourceKind) => {
    setSource(k);
    setView(null);
  };

  useEffect(() => {
    latest.current = null;
    count.current = 0;
    let last = performance.now();
    const tick = setInterval(() => {
      const f = getLatestFrame();
      const now = performance.now();
      const hz = Math.round((count.current * 1000) / (now - last));
      count.current = 0;
      last = now;
      setView(
        f
          ? { brake: pct(f.brake.normalized), steering: pct(f.steering.normalized), throttle: pct(f.throttle.normalized), hz }
          : { brake: null, steering: null, throttle: null, hz },
      );
    }, DISPLAY_MS);
    return () => clearInterval(tick);
  }, [source, getLatestFrame]);

  useEffect(() => {
    if (source !== 'mock' || !mockRunning) return;
    return startMockSource(onFrame, {
      values: () => {
        const o = followRef.current;
        if (!o.on) return null;
        const s = svc.runnerRef.current?.getSnapshot();
        const target = s?.state === 'ACTIVE' ? (s.target?.values ?? (s.selfPaced ? s.terminalTargets : undefined)) : undefined;
        return followValues(target, { offset: o.offset, noise: o.noise, overlap: performance.now() < overlapUntil.current });
      },
    });
  }, [source, mockRunning, onFrame, svc]);

  return (
    <main>
      <h1>Trail Braking Trainer</h1>
      <p className="banner" role="note">
        Phase 3 build. Mock input is labelled MOCK. Hardware readings, sounds and browser speech are unverified until
        recorded in the validation log. GT7 uses a prototype client against a MOCK collector. Scoring, metrics and graphs
        are not implemented yet (Phase 4); session results stay in memory only.
      </p>

      <fieldset>
        <legend>Input source</legend>
        <label>
          <input type="radio" name="source" checked={source === 'mock'} onChange={() => selectSource('mock')} /> MOCK
        </label>
        <label>
          <input type="radio" name="source" checked={source === 'gamepad'} onChange={() => selectSource('gamepad')} />{' '}
          Gamepad / wheel
        </label>
        <label>
          <input type="radio" name="source" checked={source === 'gt7'} onChange={() => selectSource('gt7')} /> GT7
          collector (prototype, mock server)
        </label>
      </fieldset>

      {source === 'mock' && (
        <>
          <button type="button" className="toggle" onClick={() => setMockRunning((r) => !r)}>
            {mockRunning ? 'Stop mock input' : 'Start mock input'}
          </button>
          <p>
            <label>
              <input type="checkbox" checked={follow.on} onChange={(e) => setFollow({ ...follow, on: e.target.checked })} /> MOCK: follow the drill target
              (hands-off guided session)
            </label>{' '}
            <label>
              offset{' '}
              <input type="number" min={-0.5} max={0.5} step={0.01} value={follow.offset} onChange={(e) => setFollow({ ...follow, offset: Number(e.target.value) || 0 })} />
            </label>{' '}
            <label>
              noise{' '}
              <input type="number" min={0} max={0.2} step={0.01} value={follow.noise} onChange={(e) => setFollow({ ...follow, noise: Math.max(0, Number(e.target.value) || 0) })} />
            </label>{' '}
            <button type="button" onClick={() => (overlapUntil.current = performance.now() + OVERLAP_MS)}>
              MOCK: inject overlap
            </button>
          </p>
        </>
      )}

      <dl className="readout" aria-live="off">
        <dt>Brake</dt>
        <dd>{view ? show(view.brake) : '--'}</dd>
        <dt>Steering</dt>
        <dd>{view ? show(view.steering, true) : '--'}</dd>
        <dt>Throttle</dt>
        <dd>{view ? show(view.throttle) : '--'}</dd>
        <dt>Frame rate</dt>
        <dd data-testid="rate">{view ? `${view.hz} Hz` : '--'}</dd>
      </dl>

      <p>
        <button type="button" onClick={() => void svc.sonify.unlock()}>
          Enable session audio
        </button>{' '}
        Session audio: <strong data-testid="session-audio">{audioState}</strong>
      </p>
      {session ? <SessionPanel runner={session.runner} bridge={session.bridge} previewSamples={session.bridge.previewSamples} /> : (
        <section aria-labelledby="session-h">
          <h2 id="session-h">Session</h2>
          <p>Session needs the core (WASM); see Core status below.</p>
        </section>
      )}
      <ControlsPanel bindings={svc.bindings} voice={svc.voice} announcer={svc.announcer} />

      <AudioCheck getLatestFrame={getLatestFrame} />
      <SonifyCheck />
      {source === 'gamepad' && <DevicesPanel onFrame={onFrame} onPads={(_, maps) => svc.setTrainingMappings(maps)} />}
      {source === 'gt7' && <Gt7Panel onFrame={onFrame} />}
      <WasmStatus />
      <footer>Version {VERSION}</footer>
    </main>
  );
}
