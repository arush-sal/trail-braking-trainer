// Runs the real Go core.wasm under Node: shared fixtures + TS-produced mock frames.
import { readdirSync, readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mockFrame } from '../input/mock/mockSource';

const wasmDir = new URL('../../public/wasm/', import.meta.url);
const fixtures = new URL('../../../../tests/contracts/frames/', import.meta.url);
type Core = { version(): string; validateFrame(json: string): string | null };
let core: Core;

beforeAll(async () => {
  runInThisContext(readFileSync(new URL('wasm_exec.js', wasmDir), 'utf8'));
  const go = new (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL('core.wasm', wasmDir)), go.importObject);
  void go.run(instance);
  core = (globalThis as unknown as { tbtCore: Core }).tbtCore;
});

describe('core.wasm contract', () => {
  it('reports a version', () => expect(core.version()).not.toBe(''));

  for (const [dir, ok] of [['valid', true], ['invalid', false]] as const) {
    for (const f of readdirSync(new URL(`${dir}/`, fixtures))) {
      it(`${dir}/${f}`, () => {
        const err = core.validateFrame(readFileSync(new URL(`${dir}/${f}`, fixtures), 'utf8'));
        if (ok) expect(err).toBeNull();
        else expect(typeof err).toBe('string');
      });
    }
  }

  it('accepts TS mockFrame output across a full cycle', () => {
    for (let i = 0; i < 1000; i++) expect(core.validateFrame(JSON.stringify(mockFrame(i, i * 10)))).toBeNull();
  });
});
