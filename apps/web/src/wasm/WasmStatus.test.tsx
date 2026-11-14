import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CoreApi } from './coreBridge';

const loader = vi.fn<() => Promise<CoreApi>>();
vi.mock('./coreBridge', async (orig) => {
  const mod = await orig<typeof import('./coreBridge')>();
  return { ...mod, coreBridge: mod.createCoreBridge(() => loader()) };
});

afterEach(cleanup);

it('core load failure shows an actionable alert; Retry loads it again without a reload', async () => {
  const { WasmStatus } = await import('./WasmStatus');
  loader.mockRejectedValueOnce(new Error('Failed to fetch core.wasm: HTTP 503'));
  render(<WasmStatus />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/HTTP 503.*Retry/);
  loader.mockResolvedValueOnce({ version: () => 'v-test', validateFrame: () => null, api: {} as never });
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading core' }));
  expect(await screen.findByText('v-test')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry loading core' })).toBeNull();
});
