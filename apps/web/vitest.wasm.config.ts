import { defineConfig } from 'vitest/config';

// Contract tests against the BUILT core.wasm (run via `make test-wasm`, after `make wasm`).
export default defineConfig({ test: { environment: 'node', include: ['src/**/*.wasm-test.ts'] } });
