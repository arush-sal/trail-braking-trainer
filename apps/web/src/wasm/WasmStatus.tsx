import { useEffect, useSyncExternalStore } from 'react';
import { coreBridge } from './coreBridge';
import { mockFrame } from '../input/mock/mockSource';
import { coreLoadHelp } from '../app/recovery';

export function WasmStatus() {
  const s = useSyncExternalStore(coreBridge.subscribe, coreBridge.getState);
  useEffect(() => {
    coreBridge.load().catch(() => undefined); // error is shown via state
  }, []);
  return (
    <section aria-label="Core status">
      <h2>Core (WASM)</h2>
      {s.status === 'error' && (
        <div role="alert">
          <p>{coreLoadHelp(s.error ?? 'unknown error')}</p>
          <button type="button" onClick={() => coreBridge.load().catch(() => undefined)}>
            Retry loading core
          </button>
        </div>
      )}
      <dl className="readout">
        <dt>Status</dt>
        <dd data-testid="wasm-status">{s.status}</dd>
        <dt>Version</dt>
        <dd data-testid="wasm-version">{s.version ?? (s.error ? `error: ${s.error}` : '--')}</dd>
        <dt>Load time</dt>
        <dd>{s.loadMs === undefined ? '--' : `${s.loadMs.toFixed(0)} ms`}</dd>
        <dt>Call overhead</dt>
        <dd data-testid="wasm-bench">{s.bench ? `mean ${s.bench.meanUs.toFixed(1)} us, p95 ${s.bench.p95Us.toFixed(1)} us (n=${s.bench.n})` : '--'}</dd>
      </dl>
      <button type="button" disabled={s.status !== 'ready'} onClick={() => coreBridge.benchmark(1000, mockFrame)}>
        Run overhead benchmark
      </button>
    </section>
  );
}
