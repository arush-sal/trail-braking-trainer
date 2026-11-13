import { describe, expect, it } from 'vitest';
import { createDeviceTracker, percentile, summarize } from './stats';
import { detectCapabilities } from './capabilities';

describe('stats', () => {
  it('percentiles (nearest rank)', () => {
    expect(percentile([], 50)).toBeNull();
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarize(v)).toEqual({ count: 100, p50: 50, p95: 95, max: 100 });
  });
  it('tracker counts changed timestamps per second and duplicates', () => {
    const t = createDeviceTracker();
    t.record(0, 1);
    t.record(100, 1);
    t.record(200, 2);
    t.record(1500, 3);
    expect(t.stats(1500)).toEqual({ hz: 1, polls: 4, duplicates: 1 });
  });
  it('capabilities detection', () => {
    expect(detectCapabilities({})).toEqual({ gamepadApi: false, speechRecognition: false, audioContext: false, secureContext: false });
    expect(
      detectCapabilities({ navigator: { getGamepads() {} }, webkitSpeechRecognition: 1, AudioContext: 1, isSecureContext: true }),
    ).toEqual({ gamepadApi: true, speechRecognition: true, audioContext: true, secureContext: true });
  });
});
