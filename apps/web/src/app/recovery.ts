// Actionable recovery texts for the spec 8 failure paths. Pure, so each one is unit-tested;
// the components only decide when to show (or speak) them.
import type { Command } from '../controls/dispatcher';
import type { EngineState } from '../audio/synth/ToneEngine';
import { commandRejected } from '../audio/speech/phrases';

/** PROPOSED: below 20 Hz (50 ms frames) the core already marks smoothness N/A (MaxSmoothIntervalMs, docs/metric-definitions.md). Tune from T2 evidence. */
export const LOW_HZ = 20;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const missingAxis = (err: string) => /^controls: (brake|steering|throttle): not available/.exec(err)?.[1] ?? null;
const NO_SOURCE = 'no live input source';

export function coreLoadHelp(error: string): string {
  const fix = /support WebAssembly/.test(error)
    ? 'Use a current Chrome, Edge, Firefox or Safari with WebAssembly enabled (some enterprise policies and strict privacy modes turn it off).'
    : 'Check your connection, then press Retry. If it keeps failing, reload the page (a new version may have been deployed) and turn off extensions that block scripts or WebAssembly.';
  return `The training core could not load (${error}). ${fix} Sessions need the core; input diagnostics and the audio check still work.`;
}

export function slowInputHelp(hz: number): string | null {
  if (hz <= 0 || hz >= LOW_HZ) return null;
  return `Input is arriving slowly (${hz} Hz, expected ${LOW_HZ} Hz or more). Feedback will lag and smoothness metrics lose resolution. Keep this tab visible and in front, close heavy tabs or apps, and check the device connection.`;
}

export function audioHelp(state: EngineState, interrupted = false): string | null {
  if (state === 'suspended')
    return `Session audio is ${interrupted ? 'interrupted by the system (a call, another app or an output device change)' : 'suspended by the browser'}. Press Enable session audio to resume; if it stays silent, check the output device and volume.`;
  if (state === 'closed') return 'Session audio has stopped. Reload the page to restore it.';
  return null;
}

/** Visible explanation of a failed start (core error or runner precondition). */
export function startHelp(err: string): string {
  const axis = missingAxis(err);
  if (axis)
    return `${cap(axis)} is not available from the current source${axis === 'steering' ? ' (the GT7 collector never provides steering)' : ''}. Pick a selection or drill without ${axis}, or map that control under Input devices.`;
  if (err === NO_SOURCE) return 'No live input. Start the MOCK input, map a control under Input devices, or connect the GT7 collector, then start again.';
  return err;
}

/** Short spoken form of a failed command, for eyes-free use. */
export function commandFailed(c: Command, err: string): string {
  const axis = missingAxis(err);
  if (axis) return `Cannot ${c}. ${cap(axis)} not available from this source.`;
  if (err === NO_SOURCE) return `Cannot ${c}. No live input.`;
  return commandRejected(c);
}
