import { useEffect, useMemo, useState } from 'react';
import type { DrillDefinition, Result } from '../../wasm/sessionBridge';

/**
 * Validates a drill through the Go core, debounced. `def` is the last definition that was validated
 * (the one safe to configure); while an edit is waiting for the debounce, `pending` is true and
 * callers must not allow Start. The first definition is validated synchronously.
 */
export function useDrillValidation(drill: DrillDefinition, validate: (d: DrillDefinition) => Pick<Result, 'error'>, delayMs = 150) {
  const key = JSON.stringify(drill);
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    if (settled === key) return;
    const id = setTimeout(() => setSettled(key), delayMs);
    return () => clearTimeout(id);
  }, [key, settled, delayMs]);
  const def = useMemo(() => JSON.parse(settled) as DrillDefinition, [settled]);
  const error = useMemo(() => validate(def).error, [def, validate]);
  const pending = settled !== key;
  return { def, pending, error: pending ? undefined : error };
}
