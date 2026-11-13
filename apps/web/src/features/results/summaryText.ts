import { fmtNum } from './chartMath';
import type { Axis } from '../../input/types';
import type { Metric, Outcome, RoundResult, SessionResults } from '../../wasm/sessionBridge';

// Spoken eyes-free, so deliberately short: per channel the mean error and the start delay only;
// the screen has every metric. No combined total by design.
const AXES: Axis[] = ['brake', 'steering', 'throttle'];
const OUTCOME_WORDS: Record<Outcome, string> = {
  completedTimed: 'completed', completedAuto: 'completed', completedManual: 'completed',
  skipped: 'skipped', invalidSourceLost: 'invalid, input source lost', aborted: 'stopped',
};
const MAE = ['accuracy.mae', 'accuracy.shapeMae', 'consistency.accuracy.mae'];
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const usable = (m: Metric | undefined): m is Metric & { value: number } => !!m && m.applicable && m.value != null;
const find = (list: Metric[], ids: string[], a: Axis) => list.find((m) => m.axis === a && ids.includes(m.id) && usable(m));
const completed = (r: RoundResult) => r.outcome.startsWith('completed');

function roundText(r: RoundResult): string {
  const parts = [`Round ${r.round}${r.attempt > 1 ? `, attempt ${r.attempt}` : ''}: ${OUTCOME_WORDS[r.outcome] ?? r.outcome}.`];
  for (const a of AXES) {
    const bits: string[] = [];
    const mae = find(r.accuracy, MAE, a);
    const start = find(r.timing, ['timing.startDelay'], a);
    if (mae) bits.push(`mean error ${fmtNum(mae.value!)} points`);
    if (start) bits.push(`start delay ${fmtNum(start.value!)} seconds`);
    if (bits.length) parts.push(`${cap(a)} ${bits.join(', ')}.`);
  }
  if (r.timing.length && !r.timing.some(usable)) parts.push('Timing is not applicable.');
  return parts.join(' ');
}

/** Short, eyes-free summary of one round (its latest attempt) or of the session. Pure; speaking is the caller's job. */
export function summaryText(results: SessionResults, round?: number): string {
  if (round !== undefined) {
    const r = results.rounds.filter((x) => x.round === round).at(-1);
    return r ? roundText(r) : `No results for round ${round}.`;
  }
  const parts = [`Session finished: ${results.rounds.length} rounds, ${results.rounds.filter(completed).length} completed.`];
  const spread = AXES.map((a) => [a, find(results.consistency, MAE, a)] as const).filter(([, m]) => m);
  if (spread.length) parts.push(`Round to round spread of mean error: ${spread.map(([a, m]) => `${a} ${fmtNum(m!.value!)} points`).join(', ')}.`);
  else if (!results.consistency.some(usable)) parts.push(`Consistency is not available${results.consistency[0]?.reason ? ': ' + results.consistency[0].reason : ''}.`);
  if (results.recommendations.length) parts.push(`${results.recommendations.length} suggestions on screen.`);
  return parts.join(' ');
}
