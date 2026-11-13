import { describe, expect, it } from 'vitest';
import { parseVidPid } from './ids';
import { applySuggestion, suggestionFor } from './suggestions';
import { defaultMapping } from './normalize';

describe('parseVidPid', () => {
  it('parses Chrome, Firefox; unknown otherwise', () => {
    expect(parseVidPid('G923 Racing Wheel for PlayStation (STANDARD GAMEPAD Vendor: 046D Product: C266)')).toEqual({ vid: '046d', pid: 'c266' });
    expect(parseVidPid('046d-c266-Logitech G923')).toEqual({ vid: '046d', pid: 'c266' });
    expect(parseVidPid('Some Wheel')).toBeNull();
  });
});

describe('suggestions', () => {
  it('G923 PS suggests pedal invert, applied only on explicit call to already-mapped axes of that device', () => {
    const s = suggestionFor({ vid: '046d', pid: 'c266' })!;
    expect(s.label).toMatch(/public info, unverified locally/);
    expect(s.source).toMatch(/^https:/);
    const m = {
      brake: defaultMapping('d#0', 'axis', 2),
      throttle: defaultMapping('d#0', 'axis', 1),
      steering: defaultMapping('d#0', 'axis', 0),
    };
    const out = applySuggestion(s, m, 'd#0');
    expect(out.brake?.invert).toBe(true);
    expect(out.throttle?.invert).toBe(true);
    expect(out.steering?.invert).toBe(false);
    expect(applySuggestion(s, m, 'other#0').brake?.invert).toBe(false);
    expect(m.brake.invert).toBe(false);
  });
  it('Fanatec DD base gets a note and no polarity', () => {
    const s = suggestionFor({ vid: '0eb7', pid: '0020' })!;
    expect(s.note).toMatch(/cannot be told apart from id; confirm manually/);
    expect(s.pedalInvert).toBe(false);
  });
  it('unknown ids have no suggestion', () => {
    expect(suggestionFor({ vid: '1234', pid: '5678' })).toBeNull();
  });
});
