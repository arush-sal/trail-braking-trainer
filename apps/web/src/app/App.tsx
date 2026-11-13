import { useCallback, useEffect, useRef, useState } from 'react';
import { startMockSource } from '../input/mock/mockSource';
import type { InputFrame } from '../input/types';
import { DevicesPanel } from '../features/devices/DevicesPanel';
import { AudioCheck } from '../features/audio/AudioCheck';
import { WasmStatus } from '../wasm/WasmStatus';
import { Gt7Panel } from '../input/gt7/Gt7Panel';

const VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';
const DISPLAY_MS = 100; // ~10 Hz display refresh; samples never trigger renders
// A frame older than this is treated as no input (source stopped/lost), so audio
// and readout never present stale values as live (spec 4.4). ponytail: fixed
// threshold; tune from hardware poll-rate evidence.
const STALE_MS = 250;

type SourceKind = 'mock' | 'gamepad' | 'gt7';
type View = { brake: number | null; steering: number | null; throttle: number | null; hz: number };
// Unavailable channels stay null and render as n/a, never 0 (spec 4.1).
const pct = (v: number | null) => (v === null ? null : Math.round(v * 100));
const show = (v: number | null, signed = false) =>
  v === null ? 'n/a' : `${signed && v > 0 ? '+' : ''}${v}%`;

export function App() {
  const [source, setSource] = useState<SourceKind>('mock');
  const [mockRunning, setMockRunning] = useState(false);
  const [view, setView] = useState<View | null>(null);
  // Single ingestion boundary: every source writes here; consumers read it.
  const latest = useRef<InputFrame | null>(null);
  const count = useRef(0);
  const onFrame = useCallback((f: InputFrame) => {
    latest.current = f;
    count.current++;
  }, []);
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
    return startMockSource(onFrame);
  }, [source, mockRunning, onFrame]);

  return (
    <main>
      <h1>Trail Braking Trainer</h1>
      <p className="banner" role="note">
        Phase 1 feasibility build. Mock input is labelled MOCK. Hardware readings are unverified until recorded in the
        validation log. GT7 uses a prototype client against a MOCK collector; drills and scoring are not implemented yet.
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
        <button type="button" className="toggle" onClick={() => setMockRunning((r) => !r)}>
          {mockRunning ? 'Stop mock input' : 'Start mock input'}
        </button>
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

      <AudioCheck getLatestFrame={getLatestFrame} />
      {source === 'gamepad' && <DevicesPanel onFrame={onFrame} />}
      {source === 'gt7' && <Gt7Panel onFrame={onFrame} />}
      <WasmStatus />
      <footer>Version {VERSION}</footer>
    </main>
  );
}
