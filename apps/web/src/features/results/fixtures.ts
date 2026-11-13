import type { Metric, SessionResults } from '../../wasm/sessionBridge';

const m = (over: Partial<Metric>): Metric => ({
  id: 'accuracy.mae', label: 'Mean absolute error', axis: 'brake', value: 4.2, unit: 'pp',
  better: 'lower', applicable: true, coverage: 0.95, formulaVersion: 'accuracy/v1', ...over,
});

export const fixture = (): SessionResults => ({
  apiVersion: 1,
  mode: 'guided',
  rounds: [
    {
      round: 1, attempt: 1, outcome: 'completedTimed', selfPaced: false, durationMs: 400,
      phases: [{ index: 0, name: 'ramp', startMs: 0 }, { index: 1, name: 'hold', startMs: 200 }],
      traces: {},
      display: {
        brake: { t: [0, 100, 200, 300, 400], desired: [0, 0.5, 1, 1, 0], actual: [0, 0.4, null, 0.9, 0], filtered: [0, 0.42, null, 0.88, 0.02], valid: [true, true, false, true, true] },
        throttle: { t: [0, 100, 200], desired: [0, 0, 0], actual: [0, 0.1, 0.2], valid: [true, true, true] },
      },
      accuracy: [m({}), m({ id: 'accuracy.mae', axis: 'throttle', value: 1.5 }), m({ id: 'accuracy.bias', label: 'Bias', value: -2, better: 'n/a' })],
      smoothness: [m({ id: 'smoothness.reversals', label: 'Reversals', unit: 'count', value: 2, formulaVersion: 'smoothness/v1' })],
      timing: [m({ id: 'timing.startDelay', label: 'Start delay', unit: 's', axis: undefined, value: 0.12, formulaVersion: 'timing/v1' })],
    },
    {
      round: 2, attempt: 1, outcome: 'completedManual', selfPaced: true, durationMs: 3000,
      phases: [],
      traces: {},
      display: { brake: { t: [0, 1000, 2000, 3000], actual: [0, 0.5, 0.2, 0], valid: [true, true, true, true] } },
      shape: { brake: { u: [0, 0.5, 1], actual: [0, 0.6, 0.2], desired: [0, 1, 0] } },
      accuracy: [m({ value: 6.1 })],
      smoothness: [m({ id: 'smoothness.reversals', label: 'Reversals', unit: 'count', value: 3, formulaVersion: 'smoothness/v1' })],
      timing: [m({ id: 'timing.startDelay', label: 'Start delay', unit: 's', axis: undefined, value: null, applicable: false, reason: 'self-paced drill has no clock', formulaVersion: 'timing/v1' })],
    },
    {
      round: 3, attempt: 2, outcome: 'invalidSourceLost', selfPaced: false, durationMs: 0,
      phases: [], traces: {}, display: {}, accuracy: [], smoothness: [], timing: [],
    },
  ],
  consistency: [m({ id: 'consistency.accuracy.mae', label: 'Spread of mean error', axis: 'brake', value: 1.2, unit: 'pp', formulaVersion: 'consistency/v1' })],
  recommendations: [
    { id: 'r1', text: 'Brake release was late; try a longer ramp.', change: { path: 'drill.rampMs', from: 800, to: 1200 } },
    { id: 'r2', text: 'Keep practicing holds.' },
  ],
});
