// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { wasmAssetsPlugin } from '../vite/wasmAssets.ts';

/** Tiny site with fake runtime/core in public/wasm, built with the plugin. */
async function buildFixture(core: string) {
  const root = mkdtempSync(join(tmpdir(), 'wasm-assets-'));
  mkdirSync(join(root, 'public/wasm'), { recursive: true });
  writeFileSync(join(root, 'public/wasm/wasm_exec.js'), 'globalThis.Go = class {};\n');
  writeFileSync(join(root, 'public/wasm/core.wasm'), core);
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  writeFileSync(join(root, 'main.js'), 'console.log(import.meta.env.VITE_WASM_EXEC_URL, import.meta.env.VITE_CORE_WASM_URL);\n');
  await build({ root, configFile: false, logLevel: 'silent', plugins: [wasmAssetsPlugin()] });
  const dist = join(root, 'dist');
  const js = readdirSync(join(dist, 'assets')).filter((f) => /^index-.*\.js$/.test(f)).map((f) => readFileSync(join(dist, 'assets', f), 'utf8')).join('');
  return { dist, js, assets: readdirSync(join(dist, 'assets')) };
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

describe('wasmAssetsPlugin (index.html, runtime and core always match)', () => {
  it('emits content-hashed runtime + core under assets/, references them from the app JS, and drops the unhashed copies', async () => {
    const a = await buildFixture('\0asm-one');
    const core = `core-${sha('\0asm-one')}.wasm`;
    const exec = `wasm_exec-${sha('globalThis.Go = class {};\n')}.js`;
    expect(a.assets).toEqual(expect.arrayContaining([core, exec]));
    expect(readFileSync(join(a.dist, 'assets', core), 'utf8')).toBe('\0asm-one');
    expect(a.js).toContain(`assets/${core}`);
    expect(a.js).toContain(`assets/${exec}`);
    expect(existsSync(join(a.dist, 'wasm'))).toBe(false);
  }, 30_000);

  it('a different core gets a different URL (no cache can pair an old app with a new core)', async () => {
    const a = await buildFixture('\0asm-one');
    const b = await buildFixture('\0asm-two');
    expect(a.js).not.toBe(b.js);
    expect(b.assets).toContain(`core-${sha('\0asm-two')}.wasm`);
  }, 30_000);
});
