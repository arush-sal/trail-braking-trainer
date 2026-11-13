import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServices } from './services';
import type { SynthLike, UtteranceLike } from '../audio/speech/announcer';
import type { RecognitionLike } from '../controls/voice';

afterEach(() => vi.useRealTimers());

function fakeSynth() {
  const spoken: string[] = [];
  const synth: SynthLike = { speaking: false, speak: (u) => void spoken.push(u.text), cancel: () => undefined, getVoices: () => [] };
  const createUtterance = (text: string): UtteranceLike => ({ text, rate: 1, voice: null, onstart: null, onend: null, onerror: null });
  return { spoken, speech: { synth, createUtterance } };
}

describe('createServices', () => {
  it('speaks the stop confirmation prompt when voice needs a second "stop"', async () => {
    const s = fakeSynth();
    let rec: RecognitionLike | null = null;
    class Rec {
      continuous = false; interimResults = false; lang = ''; maxAlternatives = 1;
      onstart = null; onend = null; onerror = null; onresult: RecognitionLike['onresult'] = null;
      constructor() { rec = this as unknown as RecognitionLike; }
      start() {} stop() {} abort() {}
    }
    const svc = createServices({ ...s.speech, voiceCtor: Rec as never, queryMic: async () => 'granted' });
    await svc.voice.enable({ privacyAcknowledged: true });
    rec!.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'stop', confidence: 0.9 } }] } as never);
    expect(s.spoken).toEqual(['Say stop again to confirm.']);
  });

  it('polls gamepad command buttons independently of the training source, only while needed', () => {
    vi.useFakeTimers();
    const s = fakeSynth();
    const pad = { id: 'Pad', index: 0, connected: true, timestamp: 0, axes: [], buttons: [{ value: 0 }, { value: 0 }] };
    const getGamepads = vi.fn(() => [pad]);
    const svc = createServices({ ...s.speech, getGamepads, raf: null });
    const stop = svc.watchPads();
    vi.advanceTimersByTime(100);
    expect(getGamepads).not.toHaveBeenCalled(); // no button binding, not learning: no polling
    svc.bindings.learn('stop', 'gamepad');
    vi.advanceTimersByTime(50);
    pad.buttons[1]!.value = 1;
    vi.advanceTimersByTime(50);
    expect(svc.bindings.list().buttons).toEqual([{ deviceId: 'Pad#0', index: 1, action: 'stop' }]);
    pad.buttons[1]!.value = 0;
    vi.advanceTimersByTime(50);
    pad.buttons[1]!.value = 1;
    vi.advanceTimersByTime(50);
    expect(s.spoken).toEqual(['Cannot stop now.']); // dispatched; no session yet -> rejected aloud
    svc.bindings.unbindButton('Pad#0', 1);
    getGamepads.mockClear();
    vi.advanceTimersByTime(100);
    expect(getGamepads).not.toHaveBeenCalled();
    stop();
  });

  it('a gamepad button mapped as a training input cannot be bound as a command', () => {
    const svc = createServices({ ...fakeSynth().speech, getGamepads: () => [], raf: null });
    svc.setTrainingMappings({ brake: { deviceId: 'Pad#0', kind: 'button', index: 7 } as never });
    expect(svc.bindings.bindButton('Pad#0', 7, 'stop')).toEqual({ ok: false, reason: 'training-input' });
  });

  it('test hooks exist only in the e2e build mode, and the trace is bounded', () => {
    expect(createServices({ ...fakeSynth().speech }).hook).toBeUndefined(); // MODE 'test' (dev is the same)
    vi.stubEnv('MODE', 'e2e');
    try {
      const svc = createServices({ ...fakeSynth().speech, getGamepads: () => [], raf: null });
      for (let i = 0; i < 5000; i++) svc.trace!({ say: String(i) });
      expect(svc.hook!.phrases.length).toBeLessThanOrEqual(1000);
      expect(svc.hook!.phrases.at(-1)).toBe('4999');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
