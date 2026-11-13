export const COMMANDS = ['start', 'pause', 'resume', 'complete', 'skip', 'stop'] as const;
export type Command = (typeof COMMANDS)[number];
export type CommandSource = 'keyboard' | 'button' | 'voice' | 'ui';
export type RejectReason = 'not-allowed' | 'duplicate' | 'sink-error';
export type DispatchResult = { ok: true } | { ok: false; reason: RejectReason };

export type DispatcherOptions = {
  /** Current session state check (from the session/bridge facade). */
  allowed: (cmd: Command) => boolean;
  sink: (cmd: Command, source: CommandSource) => void;
  /** Called for not-allowed commands so the orchestrator can give audible feedback. */
  onReject?: (cmd: Command, source: CommandSource, reason: RejectReason) => void;
  now?: () => number;
  debounceMs?: number;
};

/** The single entry point for session commands from keyboard, buttons, voice and UI. */
export function createDispatcher(o: DispatcherOptions) {
  const now = o.now ?? (() => performance.now());
  const debounceMs = o.debounceMs ?? 300;
  const lastAt = new Map<Command, number>();
  return {
    dispatch(cmd: Command, source: CommandSource): DispatchResult {
      const t = now();
      const prev = lastAt.get(cmd);
      if (prev !== undefined && t - prev < debounceMs) return { ok: false, reason: 'duplicate' };
      if (!o.allowed(cmd)) {
        o.onReject?.(cmd, source, 'not-allowed');
        return { ok: false, reason: 'not-allowed' };
      }
      lastAt.set(cmd, t);
      try {
        o.sink(cmd, source);
      } catch {
        o.onReject?.(cmd, source, 'sink-error');
        return { ok: false, reason: 'sink-error' };
      }
      return { ok: true };
    },
  };
}
export type Dispatcher = ReturnType<typeof createDispatcher>;
