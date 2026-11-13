import { useEffect, useRef, useState } from 'react';
import { startMockSource } from '../input/mock/mockSource';
import type { InputFrame } from '../input/types';

const VERSION = import.meta.env.VITE_APP_VERSION ?? 'dev';
const DISPLAY_MS = 100; // ~10 Hz display refresh; samples never trigger renders

type View = { brake: number | null; steering: number | null; throttle: number | null; hz: number };
// Unavailable channels stay null and render as n/a, never 0 (spec 4.1).
const pct = (v: number | null) => (v === null ? null : Math.round(v * 100));
const show = (v: number | null, signed = false) =>
  v === null ? 'n/a' : `${signed && v > 0 ? '+' : ''}${v}%`;

export function App() {
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const latest = useRef<InputFrame | null>(null);
  const count = useRef(0);

  useEffect(() => {
    if (!running) return;
    count.current = 0;
    let last = performance.now();
    const stop = startMockSource((f) => {
      latest.current = f;
      count.current++;
    });
    const tick = setInterval(() => {
      const f = latest.current;
      if (!f) return;
      const now = performance.now();
      const hz = Math.round((count.current * 1000) / (now - last));
      count.current = 0;
      last = now;
      setView({ brake: pct(f.brake.normalized), steering: pct(f.steering.normalized), throttle: pct(f.throttle.normalized), hz });
    }, DISPLAY_MS);
    return () => {
      stop();
      clearInterval(tick);
    };
  }, [running]);

  return (
    <main>
      <h1>Trail Braking Trainer</h1>
      <p className="banner" role="note">
        Phase 0 foundation - MOCK input only. Hardware, audio, GT7 and drills are not implemented yet.
      </p>
      <button type="button" className="toggle" onClick={() => setRunning((r) => !r)}>
        {running ? 'Stop mock input' : 'Start mock input'}
      </button>
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
      <footer>Version {VERSION}</footer>
    </main>
  );
}
