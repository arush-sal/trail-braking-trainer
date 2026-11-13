import { describe, expect, it } from 'vitest';
import { PRESETS } from './presets';

describe('preset catalog', () => {
  it('has unique ids and names', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(new Set(PRESETS.map((p) => p.def.name)).size).toBe(PRESETS.length);
  });
  it('covers every drill type, timing mode and a coast phase; marks steering provisional', () => {
    for (const t of ['hold', 'sweep', 'progressive', 'multistage']) expect(PRESETS.some((p) => p.def.type === t)).toBe(true);
    expect(PRESETS.some((p) => p.def.timing === 'selfPaced')).toBe(true);
    expect(PRESETS.some((p) => p.def.phases.some((ph) => Object.keys(ph.targets ?? {}).length === 0))).toBe(true);
    for (const p of PRESETS.filter((x) => x.def.controls.includes('steering') && x.def.type !== 'multistage')) expect(p.def.name).toMatch(/provisional/);
  });
  it('all are schema v1 with no B+T selection', () => {
    for (const p of PRESETS) {
      expect(p.def.schemaVersion).toBe(1);
      expect(p.def.controls.includes('brake') && p.def.controls.includes('throttle') && p.def.controls.length === 2).toBe(false);
    }
  });
});
