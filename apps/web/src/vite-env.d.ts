/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_APP_COMMIT?: string;
  /** Set by vite/wasmAssets.ts: content-hashed in builds, wasm/... in dev. */
  readonly VITE_WASM_EXEC_URL: string;
  readonly VITE_CORE_WASM_URL: string;
}
