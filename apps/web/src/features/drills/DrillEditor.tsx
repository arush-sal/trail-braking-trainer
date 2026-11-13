// Parameter editor (spec 3.4). Controlled by a FormState; legality is decided by the Go core, whose
// first error message arrives as `error` and is placed on the matching field (aria-invalid + text).
import { useId, useState, type ReactNode } from 'react';
import type { Axis } from '../../input/types';
import type { CompletionMode, Curve, Difficulty } from '../../wasm/sessionBridge';
import {
  LEGAL, SHORT, addPhase, controlsOf, fieldErrorPath, movePhase, removePhase, setPhase, setPhaseRamp, setSelection, setType, togglePhaseControl,
  type DrillType, type FormState, type RampForm,
} from './form';
import './drills.css';

const NAME: Record<Axis, string> = { brake: 'Brake', steering: 'Steering', throttle: 'Throttle' };
const TYPES: [DrillType, string][] = [['hold', 'Hold'], ['sweep', 'Full-range linear sweep'], ['progressive', 'Progressive curve'], ['multistage', 'Multistage']];
const CURVES: [Curve, string][] = [['linear', 'Linear'], ['easeOut', 'Fast start, gentle finish'], ['easeIn', 'Gentle start, fast finish'], ['easeInOut', 'Smooth start and finish']];
const lo = (a: Axis) => (a === 'steering' ? -100 : 0);

export type CoreError = { path: string; message: string } | null;
export const parseCoreError = (msg: string | undefined): CoreError => (msg ? { path: fieldErrorPath(msg), message: msg } : null);

/** Inline field error text, linked from the field via aria-describedby={errId(path)}. */
export const errId = (path: string) => `err-${path.replace(/[^A-Za-z0-9]/g, '-')}`;
export function FieldError({ error, path }: { error: CoreError; path: string }) {
  return error && error.path === path ? <span id={errId(path)} className="field-error"> {error.message}</span> : null;
}
const bad = (error: CoreError, path: string) => (error?.path === path ? { 'aria-invalid': true as const, 'aria-describedby': errId(path) } : {});

/** Number field with a text draft so "-" and blanks can be typed. null = blank (no override). */
export function NumField({ label, value, onChange, min, max, step = 1, blank = false, path = '', error = null, placeholder }: {
  label: ReactNode; value: number | null; onChange: (v: number | null) => void; min?: number; max?: number; step?: number; blank?: boolean; path?: string; error?: CoreError; placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft !== null && (draft === '' ? value === null : Number(draft) === value) ? draft : (value ?? '').toString();
  return (
    <label>
      {label}{' '}
      <input
        type="number" min={min} max={max} step={step} value={shown} placeholder={placeholder} {...bad(error, path)}
        onChange={(e) => {
          const t = e.target.value;
          setDraft(t);
          if (t === '') return blank ? onChange(null) : undefined;
          const n = Number(t);
          if (Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
      <FieldError error={error} path={path} />
    </label>
  );
}

type Props = {
  form: FormState;
  onChange: (f: FormState) => void;
  error: CoreError;
  /** Preset tolerance/hold for the chosen difficulty, shown as placeholders. */
  difficulties?: Partial<Record<Difficulty, { tolerance: number; completionHoldMs: number }>>;
};

export function DrillEditor({ form, onChange, error, difficulties }: Props) {
  const id = useId();
  const controls = controlsOf(form);
  const set = (p: Partial<FormState>) => onChange({ ...form, ...p });
  const diff = difficulties?.[form.difficulty];
  const single = form.type !== 'multistage';
  const topLevel = !error || ['', 'controls', 'phases', 'type', 'timing', 'difficulty', 'schemaVersion'].includes(error.path) || (single && error.path === 'phases[0]');

  const rampFields = (a: Axis, r: RampForm, onRamp: (p: Partial<RampForm>) => void, path: string, showCurve: boolean) => (
    <>
      <NumField label={`${NAME[a]} start (%)`} value={r.from} min={lo(a)} max={100} onChange={(v) => onRamp({ from: v ?? 0 })} path={`${path}.from`} error={error} />
      <NumField label={`${NAME[a]} end (%)`} value={r.to} min={lo(a)} max={100} onChange={(v) => onRamp({ to: v ?? 0 })} path={`${path}.to`} error={error} />
      {showCurve && r.from !== r.to && (
        <>
          <label>
            {NAME[a]} curve{' '}
            <select value={r.curve} onChange={(e) => onRamp({ curve: e.target.value as Curve })} {...bad(error, `${path}.curve`)}>
              {CURVES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
            </select>
            <FieldError error={error} path={`${path}.curve`} />
          </label>
          {r.curve !== 'linear' && <NumField label={`${NAME[a]} intensity (0-4)`} value={r.intensity} min={0} max={4} step={0.5} onChange={(v) => onRamp({ intensity: v ?? 1 })} path={`${path}.intensity`} error={error} />}
        </>
      )}
    </>
  );

  return (
    <div className="drill-editor">
      {error && topLevel && <p className="field-error" id={errId(error.path)}>{error.message}</p>}
      <p>
        <label>Drill name <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} /></label>
      </p>
      <fieldset aria-describedby={error?.path === 'controls' ? errId('controls') : undefined}>
        <legend>Controls (B = brake, S = steering, T = throttle; B+T is not a valid selection)</legend>
        {LEGAL.map((c, i) => (
          <label key={SHORT(c)}>
            <input type="radio" name={`${id}-sel`} checked={form.selection === i} onChange={() => onChange(setSelection(form, i))} /> {SHORT(c)}
          </label>
        ))}
      </fieldset>
      <p>
        <label>
          Pattern type{' '}
          <select value={form.type} onChange={(e) => onChange(setType(form, e.target.value as DrillType))}>
            {TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
          </select>
        </label>
      </p>
      <fieldset>
        <legend>Timing</legend>
        <label><input type="radio" name={`${id}-timing`} checked={form.timing === 'timed'} onChange={() => set({ timing: 'timed' })} /> Timed</label>
        <label><input type="radio" name={`${id}-timing`} checked={form.timing === 'selfPaced'} onChange={() => set({ timing: 'selfPaced' })} /> Self-paced</label>
        {form.timing === 'selfPaced' && (
          <>
            <p>Self-paced rounds are compared to the desired shape afterwards, over the measured round time. There is no live desired-vs-actual tone; choose timed for that.</p>
            <label>
              Round completion{' '}
              <select value={form.completion} onChange={(e) => set({ completion: e.target.value as CompletionMode })}>
                <option value="auto">Automatic (hold the end value)</option>
                <option value="manual">Manual command</option>
                <option value="either">Either</option>
              </select>
            </label>
            <NumField label="Auto-completion hold (ms, blank = difficulty preset)" value={form.holdMs} blank min={1} step={50} placeholder={diff ? String(diff.completionHoldMs) : undefined} onChange={(v) => set({ holdMs: v })} path="completionHoldMs" error={error} />
          </>
        )}
        {form.timing === 'timed' && single && <NumField label="Duration (s)" value={form.durationS} min={0.1} max={3600} step={0.5} onChange={(v) => set({ durationS: v ?? 1 })} path="phases[0].durationMs" error={error} />}
      </fieldset>

      {single && (
        <fieldset>
          <legend>Targets (percent; steering is a provisional signed scale)</legend>
          {controls.map((a) => {
            const r = form.single[a] ?? { from: 0, to: 0 };
            const path = `phases[0].targets.${a}`;
            const upd = (p: Partial<RampForm>) => set({ single: { ...form.single, [a]: { from: p.from ?? r.from, to: p.to ?? r.to } }, ...(p.curve ? { curve: p.curve } : {}), ...(p.intensity !== undefined ? { intensity: p.intensity } : {}) });
            if (form.type === 'hold') {
              return <NumField key={a} label={`${NAME[a]} hold (%)`} value={r.from} min={lo(a)} max={100} onChange={(v) => upd({ from: v ?? 0, to: v ?? 0 })} path={`${path}.from`} error={error} />;
            }
            return <div key={a}>{rampFields(a, { ...r, curve: form.type === 'progressive' ? form.curve : 'linear', intensity: form.intensity }, upd, path, form.type === 'progressive')}</div>;
          })}
        </fieldset>
      )}

      {!single && (
        <fieldset>
          <legend>Phases (order within B to S to T; brake must reach 0 before throttle rises)</legend>
          <ol>
            {form.phases.map((p, i) => {
              const ph = `phases[${i}]`;
              return (
                <li key={i}>
                  <fieldset>
                    <legend>Phase {i + 1}</legend>
                    {error?.path === ph && <p className="field-error" id={errId(ph)}>{error.message}</p>}
                    {form.timing === 'timed' && <NumField label="Duration (s)" value={p.durationS} min={0.1} max={3600} step={0.5} onChange={(v) => onChange(setPhase(form, i, { durationS: v ?? 1 }))} path={`${ph}.durationMs`} error={error} />}
                    {controls.map((a) => {
                      const r = p.targets[a];
                      return (
                        <div key={a}>
                          <label>
                            <input type="checkbox" checked={!!r} aria-label={`Phase ${i + 1} ${NAME[a]} active`} onChange={(e) => onChange(togglePhaseControl(form, i, a, e.target.checked))} /> {NAME[a]} active (off = {a === 'steering' ? 'centred' : 'released'} at 0)
                          </label>
                          {r && rampFields(a, r, (patch) => onChange(setPhaseRamp(form, i, a, patch)), `${ph}.targets.${a}`, true)}
                        </div>
                      );
                    })}
                    {controls.every((a) => !p.targets[a]) && <p>Coast phase: no control is desired.</p>}
                    <button type="button" disabled={i === 0} onClick={() => onChange(movePhase(form, i, -1))}>Move phase {i + 1} up</button>{' '}
                    <button type="button" disabled={i === form.phases.length - 1} onClick={() => onChange(movePhase(form, i, 1))}>Move phase {i + 1} down</button>{' '}
                    <button type="button" disabled={form.phases.length <= 2} onClick={() => onChange(removePhase(form, i))}>Remove phase {i + 1}</button>
                  </fieldset>
                </li>
              );
            })}
          </ol>
          <button type="button" onClick={() => onChange(addPhase(form))}>Add phase</button>
        </fieldset>
      )}

      <fieldset>
        <legend>Tolerance (percent of full travel; PROPOSED presets)</legend>
        <label>
          Difficulty{' '}
          <select value={form.difficulty} onChange={(e) => set({ difficulty: e.target.value as Difficulty })}>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
        <NumField label="Drill tolerance override (%)" value={form.tolerancePct} blank min={0.1} max={100} step={0.5} placeholder={diff ? String(Math.round(diff.tolerance * 1000) / 10) : undefined} onChange={(v) => set({ tolerancePct: v })} path="tolerance" error={error} />
        {controls.map((a) => (
          <NumField key={a} label={`${NAME[a]} tolerance override (%)`} value={form.controlTolerancePct[a] ?? null} blank min={0.1} max={100} step={0.5}
            onChange={(v) => { const m = { ...form.controlTolerancePct }; if (v === null) delete m[a]; else m[a] = v; set({ controlTolerancePct: m }); }}
            path={`controlTolerance.${a}`} error={error} />
        ))}
      </fieldset>
    </div>
  );
}
