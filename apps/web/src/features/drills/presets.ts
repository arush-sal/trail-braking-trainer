// Beginner path: named example drills (spec 3.4). All numbers are PROPOSED examples, not coaching
// advice or validated targets; steering uses the provisional signed practice scale (ADR 0003).
// Every entry is validated by the real Go core in presets.wasm-test.ts.
import type { Curve, DrillDefinition, Phase } from '../../wasm/sessionBridge';

export type DrillPreset = { id: string; description: string; def: DrillDefinition };

const v1 = { schemaVersion: 1 } as const;
const hold = (v: number) => ({ from: v, to: v });
const timedHold = (name: string, axis: 'brake' | 'steering' | 'throttle', v: number): DrillDefinition => ({
  ...v1, name, type: 'hold', timing: 'timed', controls: [axis], phases: [{ durationMs: 6000, targets: { [axis]: hold(v) } }],
});
const sweep = (name: string, axis: 'brake' | 'steering' | 'throttle', from: number, to: number, timing: 'timed' | 'selfPaced' = 'timed'): DrillDefinition => ({
  ...v1, name, type: 'sweep', timing, controls: [axis], phases: [{ ...(timing === 'timed' ? { durationMs: 4000 } : {}), targets: { [axis]: { from, to } } }],
});
const curved = (name: string, from: number, to: number, curve: Curve): DrillDefinition => ({
  ...v1, name, type: 'progressive', timing: 'timed', controls: [from > to ? 'brake' : 'throttle'],
  phases: [{ durationMs: 3000, targets: { [from > to ? 'brake' : 'throttle']: { from, to, curve, intensity: 1 } } }],
});
const staged = (name: string, controls: DrillDefinition['controls'], phases: Phase[], timing: 'timed' | 'selfPaced' = 'timed'): DrillDefinition => ({
  ...v1, name, type: 'multistage', timing, controls,
  phases: timing === 'timed' ? phases : phases.map((p) => ({ targets: p.targets })),
});

const BSTP: Phase[] = [
  { durationMs: 1000, targets: { brake: hold(0.7) } },
  { durationMs: 1500, targets: { brake: { from: 0.7, to: 0, curve: 'easeOut', intensity: 1 }, steering: { from: 0, to: 0.5 } } },
  { durationMs: 1000, targets: { steering: hold(0.5) } },
  { durationMs: 1500, targets: { steering: { from: 0.5, to: 0 }, throttle: { from: 0, to: 0.8, curve: 'easeIn', intensity: 1 } } },
  { durationMs: 1000, targets: { throttle: hold(0.8) } },
];

export const PRESETS: DrillPreset[] = [
  { id: 'hold-brake-40', description: 'Reach 40% brake and hold it for 6 s.', def: timedHold('40% brake hold', 'brake', 0.4) },
  {
    id: 'hold-brake-40-sp', description: 'Reach 40% brake and hold; the round ends when you hold it steadily or by command.',
    def: { ...v1, name: 'Self-paced 40% brake hold', type: 'hold', timing: 'selfPaced', controls: ['brake'], phases: [{ targets: { brake: hold(0.4) } }] },
  },
  { id: 'hold-throttle-60', description: 'Reach 60% throttle and hold it for 6 s.', def: timedHold('60% throttle hold', 'throttle', 0.6) },
  { id: 'hold-steering-30', description: 'Hold 30% steering for 6 s (signed steering scale is provisional).', def: timedHold('30% steering hold (steering scale provisional)', 'steering', 0.3) },
  { id: 'sweep-brake-up', description: 'Straight-line brake 0 to 100% over 4 s.', def: sweep('Brake sweep 0 to 100', 'brake', 0, 1) },
  { id: 'sweep-brake-down', description: 'Straight-line brake release 100 to 0% over 4 s.', def: sweep('Brake release sweep 100 to 0', 'brake', 1, 0) },
  { id: 'sweep-throttle-up', description: 'Straight-line throttle 0 to 100% over 4 s.', def: sweep('Throttle sweep 0 to 100', 'throttle', 0, 1) },
  { id: 'sweep-steering', description: 'Straight-line steering 0 to 100% over 4 s (signed steering scale is provisional).', def: sweep('Steering sweep 0 to 100 (steering scale provisional)', 'steering', 0, 1) },
  { id: 'sweep-brake-sp', description: 'Brake 0 to 100% at your own pace; compared afterwards by shape over the measured round time.', def: sweep('Self-paced brake sweep 0 to 100', 'brake', 0, 1, 'selfPaced') },
  { id: 'prog-fast-start', description: 'Brake release, fast start and gentle finish (easeOut), 3 s.', def: curved('Brake release fast start, gentle finish', 0.8, 0, 'easeOut') },
  { id: 'prog-gentle-start', description: 'Brake release, gentle start and fast finish (easeIn), 3 s.', def: curved('Brake release gentle start, fast finish', 0.8, 0, 'easeIn') },
  { id: 'prog-smooth', description: 'Brake release, smooth start and finish (easeInOut), 3 s.', def: curved('Brake release smooth start and finish', 0.8, 0, 'easeInOut') },
  { id: 'prog-throttle', description: 'Throttle apply, gentle start and fast finish (easeIn), 3 s.', def: curved('Throttle apply gentle start, fast finish', 0, 0.8, 'easeIn') },
  {
    id: 'stage-bs', description: 'Brake hold, then release while steering in, then steering hold.',
    def: staged('Brake release into steering', ['brake', 'steering'], [
      { durationMs: 1500, targets: { brake: hold(0.6) } },
      { durationMs: 2000, targets: { brake: { from: 0.6, to: 0, curve: 'easeOut', intensity: 1 }, steering: { from: 0, to: 0.5 } } },
      { durationMs: 1500, targets: { steering: hold(0.5) } },
    ]),
  },
  {
    id: 'stage-direct', description: 'B, B+S, then straight to S+T (brake reaches 0 as throttle starts), then T.',
    def: staged('Full trail brake', ['brake', 'steering', 'throttle'], [
      { durationMs: 1000, targets: { brake: hold(0.7) } },
      { durationMs: 1500, targets: { brake: { from: 0.7, to: 0, curve: 'easeOut', intensity: 1 }, steering: { from: 0, to: 0.5 } } },
      { durationMs: 1500, targets: { steering: { from: 0.5, to: 0 }, throttle: { from: 0, to: 0.8, curve: 'easeIn', intensity: 1 } } },
      { durationMs: 1000, targets: { throttle: hold(0.8) } },
    ]),
  },
  { id: 'stage-full', description: 'B, B+S, S, S+T, T: the full illustrative sequence with a steering-only hold.', def: staged('Staged trail brake (B, B+S, S, S+T, T)', ['brake', 'steering', 'throttle'], BSTP) },
  {
    id: 'stage-coast', description: 'As above but with a short coast phase (no targets) between steering and throttle.',
    def: staged('Staged trail brake with coast', ['brake', 'steering', 'throttle'], [
      { durationMs: 1000, targets: { brake: hold(0.6) } },
      { durationMs: 1500, targets: { brake: { from: 0.6, to: 0, curve: 'easeOut', intensity: 1 }, steering: { from: 0, to: 0.4 } } },
      { durationMs: 1000, targets: { steering: { from: 0.4, to: 0 } } },
      { durationMs: 500, targets: {} },
      { durationMs: 1500, targets: { throttle: { from: 0, to: 0.6, curve: 'easeIn', intensity: 1 } } },
      { durationMs: 1000, targets: { throttle: hold(0.6) } },
    ]),
  },
  { id: 'stage-sp', description: 'The full B, B+S, S, S+T, T sequence, self-paced (phases weighted equally; no live desired tone).', def: staged('Self-paced staged trail brake', ['brake', 'steering', 'throttle'], BSTP, 'selfPaced') },
];
