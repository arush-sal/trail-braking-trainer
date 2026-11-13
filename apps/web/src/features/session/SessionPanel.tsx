import { useEffect, useMemo, useState } from 'react';
import type { Axis } from '../../input/types';
import type { Command } from '../../controls/dispatcher';
import type { SessionBridge, Snapshot } from '../../wasm/sessionBridge';
import type { AudioChoice, SessionRunner, Setup } from './sessionRunner';
import { EXAMPLE_DRILLS } from './drills';

// Legal contiguous selections (spec 3.2). B+T is deliberately absent, so it cannot be chosen.
const SELECTIONS: Axis[][] = [['brake'], ['steering'], ['throttle'], ['brake', 'steering'], ['steering', 'throttle'], ['brake', 'steering', 'throttle']];
const short = (c: Axis[]) => c.map((a) => a[0]!.toUpperCase()).join('+');
const BUTTONS: [Command, string][] = [['start', 'Start'], ['pause', 'Pause'], ['resume', 'Resume'], ['complete', 'Complete round'], ['skip', 'Skip round'], ['stop', 'Stop']];
const REFRESH_MS = 200; // 5 Hz; the panel is not required to be looked at

export type SessionPanelProps = {
  runner: Pick<SessionRunner, 'configure' | 'getSnapshot' | 'lastError'> & { dispatcher: Pick<SessionRunner['dispatcher'], 'dispatch'> };
  bridge: Pick<SessionBridge, 'presets' | 'validateDrill'>;
};

/** Minimal Phase 3 setup + active view. All commands go through the shared dispatcher. */
export function SessionPanel({ runner, bridge }: SessionPanelProps) {
  const defaults = useMemo(() => bridge.presets().session ?? {}, [bridge]);
  const [mode, setMode] = useState<'freeform' | 'guided'>('freeform');
  const [sel, setSel] = useState(0);
  const [drillIdx, setDrillIdx] = useState(0);
  const [audio, setAudio] = useState<AudioChoice>('dual');
  const [fluct, setFluct] = useState(false);
  const [rounds, setRounds] = useState(defaults.rounds ?? 8);
  const [restS, setRestS] = useState((defaults.restMs ?? 5000) / 1000);
  const [countS, setCountS] = useState((defaults.countdownMs ?? 3000) / 1000);
  const [roundS, setRoundS] = useState((defaults.roundDurationMs ?? 10000) / 1000);
  const [snap, setSnap] = useState<Snapshot>(runner.getSnapshot());
  const [err, setErr] = useState('');

  const timing = { rounds, restMs: Math.round(restS * 1000), countdownMs: Math.round(countS * 1000) };
  const drill = { ...EXAMPLE_DRILLS[drillIdx]!, ...timing };
  const drillError = mode === 'guided' ? bridge.validateDrill(drill).error : undefined;
  const setup: Setup =
    mode === 'freeform'
      ? { name: `Freeform ${SELECTIONS[sel]!.join(' and ')}`, audioMode: audio, config: { controls: SELECTIONS[sel]!, fluctuationAlerts: fluct, session: { ...timing, roundDurationMs: Math.round(roundS * 1000) } } }
      : { name: drill.name ?? 'Guided drill', audioMode: audio, config: { drill, fluctuationAlerts: fluct } };
  const key = JSON.stringify(setup);
  useEffect(() => {
    if (!drillError) runner.configure(JSON.parse(key) as Setup);
  }, [runner, key, drillError]);

  useEffect(() => {
    const id = setInterval(() => {
      setSnap(runner.getSnapshot());
      setErr(runner.lastError);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [runner]);

  const num = (label: string, v: number, set: (n: number) => void, min: number, max: number, step = 1) => (
    <label>
      {label}{' '}
      <input type="number" min={min} max={max} step={step} value={v} onChange={(e) => set(Math.min(max, Math.max(min, Number(e.target.value) || 0)))} />
    </label>
  );

  return (
    <section aria-labelledby="session-h">
      <h2 id="session-h">Session</h2>
      <fieldset>
        <legend>Mode</legend>
        <label><input type="radio" name="mode" aria-label="Freeform" checked={mode === 'freeform'} onChange={() => setMode('freeform')} /> Freeform</label>
        <label><input type="radio" name="mode" aria-label="Guided" checked={mode === 'guided'} onChange={() => setMode('guided')} /> Guided</label>
      </fieldset>
      {mode === 'freeform' ? (
        <fieldset>
          <legend>Controls (B = brake, S = steering, T = throttle; B+T is not a valid selection)</legend>
          {SELECTIONS.map((c, i) => (
            <label key={short(c)}><input type="radio" name="controls" aria-label={short(c)} checked={sel === i} onChange={() => setSel(i)} /> {short(c)}</label>
          ))}
        </fieldset>
      ) : (
        <p>
          <label>
            Drill{' '}
            <select value={drillIdx} onChange={(e) => setDrillIdx(Number(e.target.value))}>
              {EXAMPLE_DRILLS.map((d, i) => <option key={d.name} value={i}>{d.name} ({d.timing === 'timed' ? 'timed' : 'self-paced'}, {short(d.controls)})</option>)}
            </select>
          </label>
        </p>
      )}
      {drillError && <p role="alert">Drill rejected by the core: {drillError}</p>}
      <fieldset>
        <legend>Guided audio</legend>
        <label><input type="radio" name="audio" aria-label="Dual tone" checked={audio === 'dual'} onChange={() => setAudio('dual')} /> Dual tone</label>
        <label><input type="radio" name="audio" aria-label="Deviation" checked={audio === 'deviation'} onChange={() => setAudio('deviation')} /> Deviation</label>
      </fieldset>
      <p>
        <label><input type="checkbox" checked={fluct} onChange={(e) => setFluct(e.target.checked)} /> Fluctuation alerts</label>{' '}
        {num('Rounds', rounds, setRounds, 1, 100)}{' '}
        {num('Rest (s)', restS, setRestS, 0, 600, 0.5)}{' '}
        {num('Countdown (s)', countS, setCountS, 0, 60, 0.5)}{' '}
        {mode === 'freeform' && num('Round length (s)', roundS, setRoundS, 1, 600)}
      </p>
      <p>
        {BUTTONS.map(([c, label]) => (
          <button key={c} type="button" onClick={() => runner.dispatcher.dispatch(c, 'ui')}>{label}</button>
        ))}
      </p>
      {err && <p role="status">Last command failed: {err}</p>}
      <div aria-live="off">
        <p className="big" data-testid="session-state">{snap.state}</p>
        <p data-testid="session-status">
          Round {snap.round} of {snap.rounds}, {snap.roundsDone} done. Primary: {snap.primary ?? 'n/a'}.
        </p>
      </div>
    </section>
  );
}
