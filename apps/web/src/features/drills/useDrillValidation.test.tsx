import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDrillValidation } from './useDrillValidation';
import { buildDrill, defaultForm } from './form';

afterEach(() => vi.useRealTimers());

describe('useDrillValidation', () => {
  it('validates the first drill immediately and debounces later edits (pending until settled)', () => {
    vi.useFakeTimers();
    const validate = vi.fn((d: { rounds?: number }) => ({ apiVersion: 1, events: [], error: d.rounds === 0 ? 'rounds: bad' : undefined }));
    const { result, rerender } = renderHook(({ rounds }) => useDrillValidation(buildDrill({ ...defaultForm(), rounds }), validate, 100), { initialProps: { rounds: 8 } });
    expect(result.current).toMatchObject({ pending: false, error: undefined });
    rerender({ rounds: 0 });
    expect(result.current.pending).toBe(true);
    expect(validate).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(100));
    expect(result.current).toMatchObject({ pending: false, error: 'rounds: bad' });
    expect(result.current.def.rounds).toBe(0);
  });
});
