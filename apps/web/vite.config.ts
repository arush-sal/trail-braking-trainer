import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { versionPlugin } from './vite/versionInfo.ts';
import { wasmAssetsPlugin } from './vite/wasmAssets.ts';

export default defineConfig({
  plugins: [react(), versionPlugin(), wasmAssetsPlugin()],
  build: { sourcemap: false },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
