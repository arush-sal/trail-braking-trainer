import { useEffect, useMemo, useRef, useState } from 'react';
import type { Axis } from '../../input/types';
import type { Command } from '../../controls/dispatcher';
import type { Difficulty, Recommendation, SessionBridge, SessionResults, Snapshot } from '../../wasm/sessionBridge';
import { ResultsView } from '../results/ResultsView';
import type { AudioChoice, SessionRunner, Setup } from './sessionRunner';
import { PRESETS } from '../drills/presets';
import { LEGAL, SHORT, buildDrill, fromDrill, type FormState } from '../drills/form';
import { DrillEditor, NumField, parseCoreError } from '../drills/DrillEditor';
import { SetupPreview, type PreviewSamples } from '../drills/SetupPreview';
import { useDrillValidation } from '../drills/useDrillValidation';
import { startHelp } from '../../app/recovery';

// Freeform offers only the legal contiguous selections (spec 3.2); B+T is deliberately absent.
const SELECTIONS: Axis[][] = LEGAL;
const short = SHORT;
const BUTTONS: [Command, string][] = [['start', 'Start'], ['pause', 'Pause'], ['resume', 'Resume'], ['complete', 'Complete round'], ['skip', 'Skip round'], ['stop', 'Stop']];
const REFRESH_MS = 200; // 5 Hz; the panel is not required to be looked at
const CUSTOM = 'custom';
const EDIT_DEBOUNCE_MS = 150;
// Results are fetched from the core once per finished round / session end (never per refresh).
const resultsKey = (s: Snapshot) => (s.state === 'REST' || s.state === 'COMPLETE' || s.state === 'ABORTED' ? `${s.state}:${s.roundsDone}` : null);

export type SessionPanelProps = {
  runner: Pick<SessionRunner, 'configure' | 'getSnapshot' | 'lastError'> & { dispatcher: Pick<SessionRunner['dispatcher'], 'dispatch'> };
  bridge: Pick<SessionBridge, 'presets' | 'validateDrill' | 'results'>;
  /** Core sampler for the setup preview (bridge.previewSamples); without it the preview says it is unavailable. */
  previewSamples?: PreviewSamples;
};

/** Setup + active view: freeform, or guided from the preset catalog / parameter editor. All commands go through the shared dispatcher. */
export function SessionPanel({ runner, bridge, previewSamples }: SessionPanelProps) {
  const presets = useMemo(() => bridge.presets(), [bridge]);
  const defaults = presets.session ?? {};
  const [mode, setMode] = useState<'freeform' | 'guided'>('freeform');
  const [sel, setSel] = useState(0);
  const [presetId, setPresetId] = useState(PRESETS[0]!.id);
  const [form, setForm] = useState<FormState>(() => ({
    ...fromDrill(PRESETS[0]!.def), rounds: defaults.rounds ?? 8, restS: (defaults.restMs ?? 5000) / 1000, countdownS: (defaults.countdownMs ?? 3000) / 1000,
  }));
  const [audio, setAudio] = useState<AudioChoice>('dual');
  const [fluct, setFluct] = useState(false);
  const [spoken, setSpoken] = useState(true);
  const [roundS, setRoundS] = useState((defaults.roundDurationMs ?? 10000) / 1000);
  const [snap, setSnap] = useState<Snapshot>(runner.getSnapshot());
  const [err, setErr] = useState('');
  const [results, setResults] = useState<SessionResults | null>(null);
  const resKey = useRef<string | null>(null);
  // Typing in the parameter editor is debounced; presets and the common numbers apply on the next tick.
  const [delayMs, setDelayMs] = useState(0);

  const preset = PRESETS.find((p) => p.id === presetId);
  const { def: drill, pending, error: drillError } = useDrillValidation(buildDrill(form), bridge.validateDrill, delayMs);
  const guided = mode === 'guided';
  const coreError = guided ? parseCoreError(drillError) : null;
  const blocked = guided && (pending || !!drillError);
  const timing = { rounds: form.rounds, restMs: Math.round(form.restS * 1000), countdownMs: Math.round(form.countdownS * 1000) };
  const setup: Setup & { spokenFeedback: boolean } =
    mode === 'freeform'
      ? { name: `Freeform ${SELECTIONS[sel]!.join(' and ')}`, audioMode: audio, spokenFeedback: spoken, config: { controls: SELECTIONS[sel]!, fluctuationAlerts: fluct, session: { ...timing, roundDurationMs: Math.round(roundS * 1000) } } }
      : { name: drill.name ?? 'Guided drill', audioMode: audio, spokenFeedback: spoken, config: { drill, fluctuationAlerts: fluct, ...(drill.timing === 'selfPaced' ? { completion: form.completion } : {}) } };
  const key = JSON.stringify(setup);
  // While the drill is invalid or still validating there is no setup: keys/voice/buttons cannot start a stale one.
  useEffect(() => {
    runner.configure(blocked ? null : (JSON.parse(key) as Setup));
  }, [runner, key, blocked]);

  /** Only after the user confirmed in ResultsView; changes the form, i.e. the NEXT session. */
  const applyRecommendation = (rec: Recommendation) => {
    if (rec.change?.path !== 'difficulty') return;
    setDelayMs(0);
    setPresetId(CUSTOM);
    setForm((f) => ({ ...f, difficulty: rec.change!.to as Difficulty }));
  };

  const choosePreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setDelayMs(0);
    setPresetId(id);
    setForm((f) => ({ ...fromDrill(p.def), rounds: f.rounds, restS: f.restS, countdownS: f.countdownS }));
  };

  useEffect(() => {
    const id = setInterval(() => {
      const s = runner.getSnapshot();
      setSnap(s);
      setErr(runner.lastError);
      const k = resultsKey(s);
      if (k !== resKey.current) {
        resKey.current = k;
        setResults(k ? bridge.results() : null);
      }
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [runner, bridge]);

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
        <>
          <p>
            <label>
              Drill{' '}
              <select value={presetId} onChange={(e) => (e.target.value === CUSTOM ? setPresetId(CUSTOM) : choosePreset(e.target.value))}>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.def.name} ({p.def.timing === 'timed' ? 'timed' : 'self-paced'}, {short(p.def.controls)})</option>)}
                <option value={CUSTOM}>{form.name} (custom: {form.timing === 'timed' ? 'timed' : 'self-paced'}, {short(LEGAL[form.selection]!)})</option>
              </select>
            </label>
          </p>
          <p>{preset?.description ?? 'Custom drill built from the parameters below.'} Preset numbers are proposed examples, not coaching advice.</p>
          <details>
            <summary>Customize drill parameters</summary>
            <DrillEditor form={form} error={coreError} difficulties={presets.difficulties} onChange={(f) => { setDelayMs(EDIT_DEBOUNCE_MS); setForm(f); setPresetId(CUSTOM); }} />
          </details>
          <SetupPreview def={drill} previewSamples={previewSamples} />
          {drill.timing === 'selfPaced' && <p>Self-paced drill: audio gives position and movement feedback and an end-state cue. No live desired-vs-actual tone exists for a moving self-paced target; choose timed for that.</p>}
        </>
      )}
      {drillError && guided && <p role="alert">Drill rejected by the core: {drillError}</p>}
      {pending && guided && <p role="status">Checking drill...</p>}
      <fieldset>
        <legend>Guided audio</legend>
        <label><input type="radio" name="audio" aria-label="Dual tone" checked={audio === 'dual'} onChange={() => setAudio('dual')} /> Dual tone</label>
        <label><input type="radio" name="audio" aria-label="Deviation" checked={audio === 'deviation'} onChange={() => setAudio('deviation')} /> Deviation</label>
      </fieldset>
      <p>
        <label><input type="checkbox" checked={fluct} onChange={(e) => setFluct(e.target.checked)} /> Fluctuation alerts</label>{' '}
        <label><input type="checkbox" checked={spoken} onChange={(e) => setSpoken(e.target.checked)} /> Spoken feedback</label>{' '}
        <NumField label="Rounds" value={form.rounds} min={1} max={100} onChange={(v) => { setDelayMs(0); setForm({ ...form, rounds: Math.min(100, Math.max(1, v ?? 1)) }); }} path="rounds" error={coreError} />{' '}
        <NumField label="Rest (s)" value={form.restS} min={0} max={600} step={0.5} onChange={(v) => { setDelayMs(0); setForm({ ...form, restS: Math.min(600, Math.max(0, v ?? 0)) }); }} path="restMs" error={coreError} />{' '}
        <NumField label="Countdown (s)" value={form.countdownS} min={0} max={60} step={0.5} onChange={(v) => { setDelayMs(0); setForm({ ...form, countdownS: Math.min(60, Math.max(0, v ?? 0)) }); }} path="countdownMs" error={coreError} />{' '}
        {mode === 'freeform' && <NumField label="Round length (s)" value={roundS} min={1} max={600} onChange={(v) => setRoundS(Math.min(600, Math.max(1, v ?? 1)))} />}
      </p>
      <p>
        {BUTTONS.map(([c, label]) => (
          <button key={c} type="button" disabled={c === 'start' && blocked} onClick={() => runner.dispatcher.dispatch(c, 'ui')}>{label}</button>
        ))}
      </p>
      {err && <p role="status">Last command failed: {startHelp(err)}</p>}
      <div aria-live="off">
        <p className="big" data-testid="session-state">{snap.state}</p>
        <p data-testid="session-status">
          Round {snap.round} of {snap.rounds}, {snap.roundsDone} done. Primary: {snap.primary ?? 'n/a'}.
        </p>
      </div>
      {results && <ResultsView results={results} onApplyRecommendation={applyRecommendation} />}
    </section>
  );
}
