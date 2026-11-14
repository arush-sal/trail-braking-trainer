// Ships the Go runtime (wasm_exec.js) and core.wasm as content-hashed files under assets/, and
// bakes their URLs into the app JS. A given index.html therefore always loads the runtime and
// core it was built with, even across deploys and caches, and both can be cached immutably.
// scripts/build-wasm.sh still writes public/wasm/ (used by `vite dev` and `make test-wasm`).
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const FILES = { VITE_WASM_EXEC_URL: 'wasm_exec.js', VITE_CORE_WASM_URL: 'core.wasm' } as const;

export function wasmAssetsPlugin(dir = 'public/wasm'): Plugin {
  const emit: { fileName: string; source: Buffer }[] = [];
  let outDir = 'dist';
  return {
    name: 'tbt-wasm-assets',
    config(c, { command }) {
      const define: Record<string, string> = {};
      for (const [key, name] of Object.entries(FILES)) {
        let url = `wasm/${name}`; // dev server: unhashed, straight from public/
        if (command === 'build') {
          const source = readFileSync(join(c.root ?? process.cwd(), dir, name)); // run `make wasm` first
          const dot = name.lastIndexOf('.');
          url = `assets/${name.slice(0, dot)}-${createHash('sha256').update(source).digest('hex').slice(0, 16)}${name.slice(dot)}`;
          emit.push({ fileName: url, source });
        }
        define[`import.meta.env.${key}`] = JSON.stringify(url);
      }
      return { define };
    },
    configResolved: (c) => { outDir = join(c.root, c.build.outDir); },
    generateBundle() {
      for (const f of emit) this.emitFile({ type: 'asset', fileName: f.fileName, source: f.source });
    },
    // Vite copied public/wasm/ verbatim; drop it so nothing can load an unhashed, mismatched pair.
    closeBundle: () => rmSync(join(outDir, 'wasm'), { recursive: true, force: true }),
  };
}
