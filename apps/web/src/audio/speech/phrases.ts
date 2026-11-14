import type { Axis } from '../../input/types';
import type { Command } from '../../controls/dispatcher';

// Short eyes-free strings. Overlap is deliberately absent: the audio alert owns it.
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const exercise = (e: { name: string; rounds?: number; restSec?: number }) =>
  [`${e.name}.`, e.rounds !== undefined && `${plural(e.rounds, 'round')}.`, e.restSec !== undefined && `${plural(e.restSec, 'second')} rest.`]
    .filter(Boolean).join(' ');
export const countdown = (n: number) => (n <= 0 ? 'Go' : String(n));
export const stage = (label: string) => `Next, ${label}.`;
export const round = (r: { n: number; outcome: 'complete' | 'skipped' | 'invalid'; reason?: string }) =>
  r.outcome === 'invalid' ? `Round ${r.n} invalid.${r.reason ? ` ${cap(r.reason)}.` : ''}` : `Round ${r.n} ${r.outcome}.`;
export const roundSummary = (n: number, metrics: { name: string; text: string }[]) =>
  [`Round ${n}.`, ...metrics.map((m) => `${m.name} ${m.text}.`)].join(' ');
export const sessionComplete = (s: { total: number; completed: number; skipped: number; invalid: number }) =>
  ['Session complete.', `${s.completed} of ${plural(s.total, 'round')} completed.`, s.skipped > 0 && `${s.skipped} skipped.`, s.invalid > 0 && `${s.invalid} invalid.`]
    .filter(Boolean).join(' ');
export const sourceLost = (axis?: Axis) => `${axis ? cap(axis) : 'Input source'}${axis ? ' input' : ''} lost.`;
export const sourceRestored = (axis?: Axis) => `${axis ? cap(axis) : 'Input source'}${axis ? ' input' : ''} restored.`;

export type MicState = 'idle' | 'listening' | 'denied' | 'unsupported' | 'error' | 'network';
const MIC: Record<MicState, string> = {
  idle: 'Voice commands off.',
  listening: 'Voice commands on.',
  denied: 'Microphone denied. Use buttons.',
  unsupported: 'Voice commands not supported. Use buttons.',
  error: 'Microphone error. Use buttons.',
  network: 'Voice service unreachable. Use buttons.',
};
export const micState = (s: MicState) => MIC[s];
export const commandRejected = (c: Command) => `Cannot ${c} now.`;
export const confirmStop = () => 'Say stop again to confirm.';
export const audioSuspended = () => 'Audio paused. Press enable audio.';
