export type Priority = 'critical' | 'normal';
export type Category = 'instructions' | 'countdown' | 'roundSummary' | 'sessionSummary' | 'alerts';
/** Categories the user may switch off. 'alerts' (source loss, rejections, mic state) is always on. */
export type Toggleable = Exclude<Category, 'alerts'>;
export const TOGGLEABLE: Toggleable[] = ['instructions', 'countdown', 'roundSummary', 'sessionSummary'];

export type UtteranceLike = {
  text: string; rate: number; voice: unknown;
  onstart: (() => void) | null; onend: (() => void) | null; onerror: (() => void) | null;
};
export type VoiceInfo = { name: string; lang: string };
export type SynthLike = {
  speaking: boolean;
  speak: (u: UtteranceLike) => void;
  cancel: () => void;
  getVoices: () => readonly VoiceInfo[];
};
export type SayOptions = { priority?: Priority; interrupt?: boolean; category?: Category };
export type AnnouncerOptions = {
  /** undefined = use window.speechSynthesis if present; null = unsupported. */
  synth?: SynthLike | null;
  createUtterance?: (text: string) => UtteranceLike;
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

  const setSpeaking = (v: boolean) => {
    if (v === speaking) return;
    speaking = v;
    for (const cb of [...(v ? startCbs : endCbs)]) cb();
  };

  function next() {
    while (synth && !current && queue.length) {
      const item = queue.shift()!;
      const u = make(item.text);
      u.rate = rate;
      u.voice = (voiceName && synth.getVoices().find((v) => v.name === voiceName)) || null;
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
    voices(): VoiceInfo[] { return synth ? [...synth.getVoices()] : []; },
    onStart(cb: () => void) { startCbs.add(cb); return () => startCbs.delete(cb); },
    onEnd(cb: () => void) { endCbs.add(cb); return () => endCbs.delete(cb); },
  };
}
export type Announcer = ReturnType<typeof createAnnouncer>;
