// Built-in example drills for Phase 3 (no drill editor until Phase 4). Values are illustrative,
// not coaching advice; each is validated through the core (validateDrill) before use.
import type { DrillDefinition } from '../../wasm/sessionBridge';

export const EXAMPLE_DRILLS: DrillDefinition[] = [
  {
    schemaVersion: 1, name: '40% brake hold', type: 'hold', timing: 'timed', controls: ['brake'],
    phases: [{ durationMs: 6000, targets: { brake: { from: 0.4, to: 0.4 } } }],
  },
  {
    schemaVersion: 1, name: 'Brake release into steering', type: 'multistage', timing: 'timed', controls: ['brake', 'steering'],
    phases: [
      { durationMs: 1500, targets: { brake: { from: 0.6, to: 0.6 } } },
      { durationMs: 2000, targets: { brake: { from: 0.6, to: 0, curve: 'easeOut', intensity: 1 }, steering: { from: 0, to: 0.5 } } },
      { durationMs: 1500, targets: { steering: { from: 0.5, to: 0.5 } } },
    ],
  },
  {
    schemaVersion: 1, name: 'Full trail brake', type: 'multistage', timing: 'timed', controls: ['brake', 'steering', 'throttle'],
    phases: [
      { durationMs: 1000, targets: { brake: { from: 0.7, to: 0.7 } } },
      { durationMs: 1500, targets: { brake: { from: 0.7, to: 0, curve: 'easeOut', intensity: 1 }, steering: { from: 0, to: 0.5 } } },
      { durationMs: 1500, targets: { steering: { from: 0.5, to: 0 }, throttle: { from: 0, to: 0.8, curve: 'easeIn', intensity: 1 } } },
      { durationMs: 1000, targets: { throttle: { from: 0.8, to: 0.8 } } },
    ],
  },
  {
    schemaVersion: 1, name: 'Self-paced 40% brake hold', type: 'hold', timing: 'selfPaced', controls: ['brake'],
    phases: [{ targets: { brake: { from: 0.4, to: 0.4 } } }],
  },
];
