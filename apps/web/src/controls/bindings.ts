import type { Command, CommandSource, DispatchResult } from './dispatcher';

/** 'togglePause' resolves to pause or resume from the current state. */
export type Action = Command | 'togglePause';
export const ACTIONS: Action[] = ['start', 'togglePause', 'pause', 'resume', 'complete', 'skip', 'stop'];
export const ACTION_LABEL: Record<Action, string> = {
  start: 'Start', togglePause: 'Pause / resume', pause: 'Pause', resume: 'Resume',
  complete: 'Complete round', skip: 'Skip round', stop: 'Stop session',
};

/**
 * Default keyboard map (KeyboardEvent.code, layout independent). None is browser-reserved.
 * Space toggles pause/resume, G = "go"/start, Enter completes the round, S skips, Escape stops.
 * No default gamepad buttons: button layouts are device specific, so the user learns them.
 */
export const DEFAULT_KEYS: Record<string, Action> = { Space: 'togglePause', KeyG: 'start', Enter: 'complete', KeyS: 'skip', Escape: 'stop' };

const PRESS = 0.5;
// Keys that would fight the browser/OS or are modifiers only.
const RESERVED = /^(F\d{1,2}|Tab|ContextMenu|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|Meta.*|OS.*|Shift.*|Control.*|Alt.*|AudioVolume.*|Media.*|Browser.*)$/;

export type KeyLike = {
  code: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean;
  target?: unknown; preventDefault: () => void;
};
export type ButtonPad = { key: string; buttons: readonly number[] };
export type BindResult = { ok: true } | { ok: false; reason: 'conflict'; with: Action } | { ok: false; reason: 'reserved' | 'training-input' };
export type LearnKind = 'keyboard' | 'gamepad';
export type BindingsState = { learning: { action: Action; kind: LearnKind } | null; message: string | null };

export type BindingsOptions = {
  dispatch: (cmd: Command, source: CommandSource) => DispatchResult;
  allowed: (cmd: Command) => boolean;
  /** True if this device input is mapped as a brake/steering/throttle training input. Kept separate from command buttons. */
  isTrainingInput: (deviceId: string, kind: 'axis' | 'button', index: number) => boolean;
  initialKeys?: Record<string, Action>;
};

const editable = (t: unknown) => {
  const e = t as { tagName?: string; isContentEditable?: boolean } | null;
  return !!e && (e.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName ?? ''));
};

export function createBindings(o: BindingsOptions) {
  const keys = new Map<string, Action>(Object.entries(o.initialKeys ?? DEFAULT_KEYS));
  const buttons = new Map<string, Action>(); // `${deviceId}\u0000${index}`
  const held = new Map<string, boolean>();
  let st: BindingsState = { learning: null, message: null };
  const subs = new Set<() => void>();
  const set = (s: Partial<BindingsState>) => { st = { ...st, ...s }; for (const cb of [...subs]) cb(); };
  const bkey = (d: string, i: number) => `${d}\u0000${i}`;

  const fire = (a: Action, source: CommandSource) => {
    const cmd: Command = a === 'togglePause' ? (o.allowed('pause') ? 'pause' : o.allowed('resume') ? 'resume' : 'pause') : a;
    o.dispatch(cmd, source);
  };
  const explain = (r: BindResult, what: string) =>
    r.ok ? `Bound ${what}.` : r.reason === 'conflict' ? `${what} is already bound to ${ACTION_LABEL[r.with]}.`
      : r.reason === 'reserved' ? `${what} is reserved by the browser.` : `${what} is used as a training input.`;

  const api = {
    bindKey(code: string, action: Action, opt: { replace?: boolean } = {}): BindResult {
      if (RESERVED.test(code)) return { ok: false, reason: 'reserved' };
      const cur = keys.get(code);
      if (cur && cur !== action && !opt.replace) return { ok: false, reason: 'conflict', with: cur };
      keys.set(code, action);
      set({});
      return { ok: true };
    },
    unbindKey(code: string) { keys.delete(code); set({}); },
    bindButton(deviceId: string, index: number, action: Action, opt: { replace?: boolean } = {}): BindResult {
      if (o.isTrainingInput(deviceId, 'button', index)) return { ok: false, reason: 'training-input' };
      const cur = buttons.get(bkey(deviceId, index));
      if (cur && cur !== action && !opt.replace) return { ok: false, reason: 'conflict', with: cur };
      buttons.set(bkey(deviceId, index), action);
      set({});
      return { ok: true };
    },
    unbindButton(deviceId: string, index: number) { buttons.delete(bkey(deviceId, index)); set({}); },
    list() {
      return {
        keys: [...keys].map(([code, action]) => ({ code, action })),
        buttons: [...buttons].map(([k, action]) => {
          const [deviceId, i] = k.split('\u0000');
          return { deviceId: deviceId!, index: Number(i), action };
        }),
      };
    },
    state: () => st,
    subscribe(cb: () => void) { subs.add(cb); return () => subs.delete(cb); },
    learn(action: Action, kind: LearnKind) { set({ learning: { action, kind }, message: null }); },
    cancelLearn() { set({ learning: null }); },

    /** Returns true when the key was consumed (mapped, or captured by learn mode). */
    handleKey(e: KeyLike): boolean {
      if (e.ctrlKey || e.altKey || e.metaKey || editable(e.target)) return false;
      if (st.learning?.kind === 'keyboard') {
        if (e.repeat) return true;
        e.preventDefault();
        const r = api.bindKey(e.code, st.learning.action);
        set({ learning: null, message: explain(r, e.code) });
        return true;
      }
      const a = keys.get(e.code);
      if (!a || e.repeat) return false;
      e.preventDefault();
      fire(a, 'keyboard');
      return true;
    },
    attach(target: EventTarget = window) {
      const h = (ev: Event) => api.handleKey(ev as unknown as KeyLike);
      target.addEventListener('keydown', h);
      return () => target.removeEventListener('keydown', h);
    },

    /** Feed gamepad button snapshots (from the shared adapter poll). Only rising edges act; axes are never read. */
    pollButtons(pads: readonly ButtonPad[]) {
      const seen = new Set<string>();
      for (const p of pads) {
        p.buttons.forEach((v, i) => {
          const hk = bkey(p.key, i);
          seen.add(hk);
          const down = v >= PRESS;
          const was = held.get(hk);
          held.set(hk, down);
          if (!down || was !== false) return; // first sight or still held: no edge
          if (st.learning?.kind === 'gamepad') {
            const r = api.bindButton(p.key, i, st.learning.action);
            set({ learning: null, message: explain(r, `Button ${i}`) });
            return;
          }
          const a = buttons.get(hk);
          if (a && !o.isTrainingInput(p.key, 'button', i)) fire(a, 'button');
        });
      }
      for (const k of [...held.keys()]) if (!seen.has(k)) held.delete(k);
    },
  };
  return api;
}
export type Bindings = ReturnType<typeof createBindings>;
