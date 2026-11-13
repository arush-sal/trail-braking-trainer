import type { Mappings } from './adapter';
import type { VidPid } from './ids';

export type Suggestion = {
  label: string;
  note: string;
  source: string;
  /** Pedals are axes resting at +1 in our [-1,1] convention -> invert on mapped brake/throttle axes. */
  pedalInvert: boolean;
};

const SRC = 'https://github.com/mescon/logitech-trueforce-linux-driver/wiki/G923';
const TABLE: Record<string, Suggestion> = {
  '046d:c266': {
    label: 'G923 PlayStation (PC mode): public info, unverified locally',
    note: 'Public driver notes say all three pedals report inverted (rest +1, pressed -1). Axis indices are not published: use Detect first, then apply.',
    source: SRC,
    pedalInvert: true,
  },
  '0eb7:0020': {
    label: 'Fanatec DD base: public info, unverified locally',
    note: 'Model (CSL DD / DD Pro / ClubSport DD) cannot be told apart from id; confirm manually. No polarity seeded.',
    source: 'https://github.com/gotzl/hid-fanatecff',
    pedalInvert: false,
  },
};

export const suggestionFor = (v: VidPid | null): Suggestion | null => (v ? (TABLE[`${v.vid}:${v.pid}`] ?? null) : null);

/** Pure; only invoked by an explicit user click. Touches brake/throttle axis mappings on `deviceKey` only. */
export function applySuggestion(s: Suggestion, mappings: Mappings, deviceKey: string): Mappings {
  if (!s.pedalInvert) return { ...mappings };
  const out: Mappings = { ...mappings };
  for (const a of ['brake', 'throttle'] as const) {
    const m = mappings[a];
    if (m && m.deviceId === deviceKey && m.kind === 'axis') out[a] = { ...m, invert: true };
  }
  return out;
}
