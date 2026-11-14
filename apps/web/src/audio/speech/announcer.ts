export type Priority = 'critical' | 'normal';
export type Category = 'instructions' | 'countdown' | 'roundSummary' | 'sessionSummary' | 'alerts';
/** Categories the user may switch off. 'alerts' (source loss, rejections, mic state) is always on. */
export type Toggleable = Exclude<Category, 'alerts'>;
export const TOGGLEABLE: Toggleable[] = ['instructions', 'countdown', 'roundSummary', 'sessionSummary'];

import { rankVoices, type VoiceInfo } from './voices';
export type { VoiceInfo };

export type UtteranceLike = {
  text: string; rate: number; voice: unknown; pitch?: number; volume?: number; lang?: string;
  onstart: (() => void) | null; onend: (() => void) | null; onerror: (() => void) | null;
};
export type SynthLike = {
  speaking: boolean;
  speak: (u: UtteranceLike) => void;
  cancel: () => void;
  getVoices: () => readonly VoiceInfo[];
  /** Chrome loads voices asynchronously and fires 'voiceschanged'. */
  addEventListener?: (type: 'voiceschanged', cb: () => void) => void;
  removeEventListener?: (type: 'voiceschanged', cb: () => void) => void;
};
export type SayOptions = { priority?: Priority; interrupt?: boolean; category?: Category };
export type AnnouncerOptions = {
  /** undefined = use window.speechSynthesis if present; null = unsupported. */
  synth?: SynthLike | null;
  createUtterance?: (text: string) => UtteranceLike;
  /** Page language used to rank voices; default navigator.language. */
  lang?: string;
};

export function createAnnouncer(o: AnnouncerOptions = {}) {
  const synth: SynthLike | null =
    o.synth !== undefined ? o.synth : ((globalThis as unknown as { speechSynthesis?: SynthLike }).speechSynthesis ?? null);
  const make = o.createUtterance ?? ((t: string) => new SpeechSynthesisUtterance(t) as unknown as UtteranceLike);
  const enabled: Record<Toggleable, boolean> = { instructions: true, countdown: true, roundSummary: true, sessionSummary: true };
  const startCbs = new Set<() => void>();
  const endCbs = new Set<() => void>();
  type Item = { text: string; critical: boolean };
  const queue: Item[] = [];
  let current: Item | null = null;
  let wd: ReturnType<typeof setTimeout> | null = null;
  const clearWd = () => { if (wd) clearTimeout(wd); wd = null; };
  let speaking = false;
  let rate = 1;
  let voiceName: string | null = null;
  const lang = o.lang ?? ((typeof navigator !== 'undefined' && navigator.language) || 'en-US');
  const voiceCbs = new Set<() => void>();
  // Picked at utterance time, so a late 'voiceschanged' is picked up automatically unless the user chose a voice.
  // Cached until 'voiceschanged': Firefox on Linux (speech-dispatcher) can expose >10k voices, and
  // re-querying/ranking them on every render or utterance stalled the main thread (~100 ms per render).
  // An empty list is never cached, so browsers that fill it without firing the event still work.
  let cache: { all: readonly VoiceInfo[]; ranked: VoiceInfo[] } | null = null;
  const voiceCache = () => {
    if (cache) return cache;
    let v: readonly VoiceInfo[] = [];
    try { v = synth?.getVoices() ?? []; } catch { /* treated as no voices */ }
    const c = { all: v, ranked: rankVoices(v, lang) };
    if (v.length) cache = c;
    return c;
  };
  const all = () => voiceCache().all;
  // Spoken summaries contain the user's results, so network TTS is opt-in (consent is in memory only).
  let allowNetwork = false;
  const isLocal = (v: VoiceInfo) => v.localService === true;
  const usable = () => all().filter((v) => allowNetwork || isLocal(v));
  // First usable entry of the cached ranking == pickBest(usable()) (the ranking is a stable sort).
  const active = (): VoiceInfo | null =>
    (voiceName && usable().find((v) => v.name === voiceName)) || voiceCache().ranked.find((v) => allowNetwork || isLocal(v)) || null;
  const networkOnly = () => !allowNetwork && all().length > 0 && !all().some(isLocal);
  const onChanged = () => { cache = null; for (const cb of [...voiceCbs]) cb(); };
  synth?.addEventListener?.('voiceschanged', onChanged);

  const setSpeaking = (v: boolean) => {
    if (v === speaking) return;
    speaking = v;
    for (const cb of [...(v ? startCbs : endCbs)]) cb();
  };

  function next() {
    while (synth && !current && queue.length) {
      const item = queue.shift()!;
      const u = make(item.text);
      const voice = active();
      u.rate = rate;
      u.pitch = 1;
      u.volume = 1;
      u.voice = voice;
      u.lang = voice?.lang ?? lang;
      // Handlers of a cancelled/replaced utterance are ignored (browsers report 'interrupted' late).
      const done = () => {
        if (current !== item) return;
        clearWd();
        current = null;
        next();
      };
      // Watchdog: some browsers never fire onend; estimate duration from length so ducking/suppression cannot stick.
      clearWd();
      wd = setTimeout(() => {
        if (current !== item) return;
        try { synth.cancel(); } catch { /* ignore */ }
        done();
      }, Math.min(30000, (400 + 90 * item.text.length) / rate));
      u.onend = done;
      u.onerror = done;
      current = item;
      setSpeaking(true);
      try {
        synth.speak(u);
      } catch {
        clearWd();
        current = null;
      }
    }
    if (!current && !queue.length) setSpeaking(false);
  }

  return {
    get supported() { return synth !== null; },
    get speaking() { return speaking; },
    get rate() { return rate; },
    say(text: string, opt: SayOptions = {}): boolean {
      const critical = opt.priority === 'critical';
      const cat = opt.category ?? (critical ? 'alerts' : 'instructions');
      if (!synth || !text || (cat !== 'alerts' && !enabled[cat])) return false;
      // No local voice: the browser default may be a network voice, so never send results to it.
      if (networkOnly() && (cat === 'roundSummary' || cat === 'sessionSummary')) return false;
      const item = { text, critical };
      const interrupt = opt.interrupt ?? critical;
      // Critical items and interrupting items go ahead of queued normal items (after earlier criticals).
      const firstNormal = queue.findIndex((q) => !q.critical);
      queue.splice(critical || interrupt ? (firstNormal < 0 ? queue.length : firstNormal) : queue.length, 0, item);
      if (interrupt && current) { current = null; clearWd(); synth.cancel(); }
      next();
      return true;
    },
    cancel() {
      queue.length = 0;
      current = null;
      clearWd();
      try { synth?.cancel(); } catch { /* ignore */ }
      setSpeaking(false);
    },
    test() { this.say('Speech test. One, two, three.', { category: 'alerts' }); },
    setEnabled(c: Toggleable, on: boolean) { enabled[c] = on; },
    isEnabled(c: Category) { return c === 'alerts' || enabled[c]; },
    setRate(r: number) { rate = Math.min(2, Math.max(0.5, r)); },
    setVoice(name: string | null) { voiceName = name; },
    voices(): VoiceInfo[] { return [...all()]; },
    /** Voices ordered best-first for the page language. */
    rankedVoices(): VoiceInfo[] { return voiceCache().ranked; },
    /** The user's chosen voice, else the automatic pick (null before any voices load). */
    activeVoice: active,
    get lang() { return lang; },
    get selectedVoice() { return voiceName; },
    get allowNetwork() { return allowNetwork; },
    setAllowNetwork(on: boolean) { allowNetwork = on; onChanged(); },
    /** True when voices exist but none is local and network voices are not allowed. */
    get networkOnly() { return networkOnly(); },
    onVoicesChanged(cb: () => void) { voiceCbs.add(cb); return () => voiceCbs.delete(cb); },
    onStart(cb: () => void) { startCbs.add(cb); return () => startCbs.delete(cb); },
    onEnd(cb: () => void) { endCbs.add(cb); return () => endCbs.delete(cb); },
  };
}
export type Announcer = ReturnType<typeof createAnnouncer>;
