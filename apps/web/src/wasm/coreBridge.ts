// Single facade over the Go WASM core (spec 8). Everything else talks to this, never to tbtCore directly.
import type { InputFrame } from '../input/types';
import type { TbtApi } from './sessionBridge';

/** `api` is the session API; wrap it with createSessionBridge (sessionBridge.ts). */
export type CoreApi = { version(): string; validateFrame(f: InputFrame): string | null; api: TbtApi };
export type Bench = { n: number; meanUs: number; p95Us: number };
export type BridgeState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  version?: string;
  loadMs?: number;
  error?: string;
  bench?: Bench;
};
type FrameFn = (seq: number, monoMs: number) => InputFrame;

export function createCoreBridge(loader: () => Promise<CoreApi>) {
  let state: BridgeState = { status: 'idle' };
  let core: CoreApi | undefined;
  let pending: Promise<CoreApi> | undefined;
  const subs = new Set<() => void>();
  const set = (s: BridgeState) => {
    state = s;
    subs.forEach((f) => f());
  };

  function load(): Promise<CoreApi> {
    if (core) return Promise.resolve(core);
    pending ??= (async () => {
      set({ status: 'loading' });
      const t0 = performance.now();
      try {
        core = await loader();
        set({ status: 'ready', version: core.version(), loadMs: performance.now() - t0 });
        return core;
      } catch (e) {
        set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }

  /** Cross-language overhead: JSON.stringify + JS->Go call + Go decode/validate, per frame. */
  function benchmark(n: number, frame: FrameFn): Bench {
    if (!core) throw new Error('core not loaded');
    const frames = Array.from({ length: n }, (_, i) => frame(i, i * (1000 / 60)));
    const us: number[] = [];
    const t0 = performance.now();
    for (const f of frames) {
      const t = performance.now();
      const err = core.validateFrame(f);
      us.push((performance.now() - t) * 1000);
      if (err) throw new Error(`validateFrame rejected frame: ${err}`);
    }
    us.sort((a, b) => a - b);
    const bench = { n, meanUs: ((performance.now() - t0) * 1000) / n, p95Us: us[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0 };
    set({ ...state, bench });
    return bench;
  }

  return {
    load,
    benchmark,
    getState: () => state,
    subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  };
}

type TbtCore = { version(): string; validateFrame(json: string): string | null; api: TbtApi };

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.append(s);
  });
}

async function browserLoader(): Promise<CoreApi> {
  if (typeof WebAssembly === 'undefined') throw new Error('This browser does not support WebAssembly; the core cannot run.');
  const base = `${import.meta.env.BASE_URL}wasm/`;
  await loadScript(`${base}wasm_exec.js`);
  const go = new (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
  const res = await fetch(`${base}core.wasm`);
  if (!res.ok) throw new Error(`Failed to fetch core.wasm: HTTP ${res.status}`);
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(res.clone(), go.importObject));
  } catch {
    // Wrong MIME type on some static hosts: fall back to buffered instantiate.
    ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), go.importObject));
  }
  void go.run(instance).catch(() => undefined);
  for (let i = 0; i < 500; i++) {
    const t = (globalThis as { tbtCore?: TbtCore }).tbtCore;
    if (t) return { version: () => t.version(), validateFrame: (f) => t.validateFrame(JSON.stringify(f)) ?? null, api: t.api };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('core.wasm started but tbtCore was never exposed');
}

export const coreBridge = createCoreBridge(browserLoader);
