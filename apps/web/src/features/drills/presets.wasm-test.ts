// Presets and form-built drills through the REAL Go validation (core.wasm under Node; `make test-wasm`).
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSessionBridge, type TbtApi } from '../../wasm/sessionBridge';
import { PRESETS } from './presets';
import { LEGAL, addPhase, buildDrill, defaultForm, fromDrill, setPhaseRamp, setSelection, setType, togglePhaseControl } from './form';

const wasmDir = new URL('../../../public/wasm/', import.meta.url);
let bridge: ReturnType<typeof createSessionBridge>;

beforeAll(async () => {
  runInThisContext(readFileSync(new URL('wasm_exec.js', wasmDir), 'utf8'));
  const go = new (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL('core.wasm', wasmDir)), go.importObject);
  void go.run(instance);
  bridge = createSessionBridge((globalThis as unknown as { tbtCore: { api: TbtApi } }).tbtCore.api);
});

const err = (f: ReturnType<typeof defaultForm>) => bridge.validateDrill(buildDrill(f)).error;

describe('presets pass core validation', () => {
  for (const p of PRESETS) it(p.id, () => expect(bridge.validateDrill(p.def).error).toBeUndefined());
  for (const p of PRESETS) it(`${p.id} via form round trip`, () => expect(err(fromDrill(p.def))).toBeUndefined());
});

describe('form-built drills', () => {
  it('every legal selection x single-phase type (first control active, rest at 0) builds a valid drill', () => {
    for (let i = 0; i < LEGAL.length; i++) {
      for (const type of ['hold', 'sweep', 'progressive'] as const) {
        const single = Object.fromEntries(LEGAL[i]!.map((a, k) => [a, k === 0 ? { from: type === 'hold' ? 30 : 0, to: 30 } : { from: 0, to: 0 }]));
        expect(err({ ...setSelection(defaultForm(), i), type, single }), `${i} ${type}`).toBeUndefined();
      }
    }
  });

  it('rejects simultaneous brake and throttle in one phase (B/T exclusion)', () => {
    let f = setType(setSelection(defaultForm(), 5), 'multistage');
    f = { ...f, phases: [{ durationS: 1, targets: { brake: { from: 50, to: 0, curve: 'linear', intensity: 1 }, throttle: { from: 0, to: 50, curve: 'linear', intensity: 1 } } }, { durationS: 1, targets: { throttle: { from: 50, to: 50, curve: 'linear', intensity: 1 } } }] };
    expect(err(f)).toMatch(/phases\[0\]: brake and throttle/);
  });

  it('rejects brake after throttle and discontinuities', () => {
    let f = fromDrill(PRESETS.find((p) => p.id === 'stage-full')!.def);
    f = addPhase(f);
    f = togglePhaseControl(f, 5, 'brake', true);
    f = setPhaseRamp(f, 5, 'brake', { from: 20, to: 20 });
    expect(err(f)).toMatch(/phases\[5\]/);
    const g = setPhaseRamp(fromDrill(PRESETS.find((p) => p.id === 'stage-full')!.def), 1, 'steering', { to: 40 });
    expect(err(g)).toBeUndefined(); // continuity propagated to the next phase
    const h = { ...g, phases: g.phases.map((p, i) => (i === 2 ? { ...p, targets: { steering: { from: 10, to: 10, curve: 'linear' as const, intensity: 1 } } } : p)) };
    expect(err(h)).toMatch(/discontinuous/);
  });

  it('field-level messages: rounds 0, tolerance 0 handled', () => {
    expect(err({ ...defaultForm(), rounds: -1 })).toMatch(/^rounds:/);
    expect(err({ ...defaultForm(), tolerancePct: 150 })).toMatch(/^tolerance:/);
  });
});
