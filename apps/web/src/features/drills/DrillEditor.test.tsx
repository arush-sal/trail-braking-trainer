import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DrillEditor, parseCoreError } from './DrillEditor';
import { fromDrill, buildDrill, type FormState } from './form';
import { PRESETS } from './presets';

afterEach(cleanup);
const load = (id: string) => fromDrill(PRESETS.find((p) => p.id === id)!.def);

function Harness({ initial, msg, onForm }: { initial: FormState; msg?: string; onForm: (f: FormState) => void }) {
  const [f, setF] = useState(initial);
  return <DrillEditor form={f} onChange={(n) => { onForm(n); setF(n); }} error={parseCoreError(msg)} />;
}

describe('DrillEditor', () => {
  it('offers only the six legal selections (no B+T) and switching drops deselected controls', () => {
    const out: { form?: FormState } = {};
    render(<Harness initial={load('stage-full')} onForm={(n) => { out.form = n; }} />);
    expect(screen.getAllByRole('radio', { name: /^(B|S|T)(\+(B|S|T))*$/ }).map((r) => r.parentElement!.textContent!.trim())).toEqual(['B', 'S', 'T', 'B+S', 'S+T', 'B+S+T']);
    fireEvent.click(screen.getByRole('radio', { name: 'B+S' }));
    expect(buildDrill(out.form!).controls).toEqual(['brake', 'steering']);
    expect(out.form!.phases.every((p) => !p.targets.throttle)).toBe(true);
  });

  it('edits hold value in percent and builds normalized targets', () => {
    const out: { form?: FormState } = {};
    render(<Harness initial={load('hold-brake-40')} onForm={(n) => { out.form = n; }} />);
    fireEvent.change(screen.getByLabelText(/Brake hold/), { target: { value: '55' } });
    expect(buildDrill(out.form!).phases[0]!.targets).toEqual({ brake: { from: 0.55, to: 0.55 } });
  });

  it('timing: self-paced shows the honest note and completion options, hides duration', () => {
    const out: { form?: FormState } = {};
    render(<Harness initial={load('hold-brake-40')} onForm={(n) => { out.form = n; }} />);
    expect(screen.getByLabelText(/Duration/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Self-paced' }));
    expect(screen.queryByLabelText(/Duration/)).toBeNull();
    expect(screen.getByText(/no live desired-vs-actual tone/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Round completion'), { target: { value: 'manual' } });
    expect(out.form!.completion).toBe('manual');
  });

  it('progressive: curve and intensity edit the ramp profile', () => {
    const out: { form?: FormState } = {};
    render(<Harness initial={load('prog-smooth')} onForm={(n) => { out.form = n; }} />);
    fireEvent.change(screen.getByLabelText(/Brake curve/), { target: { value: 'easeIn' } });
    fireEvent.change(screen.getByLabelText(/Brake intensity/), { target: { value: '2.5' } });
    expect(buildDrill(out.form!).phases[0]!.targets!.brake).toEqual({ from: 0.8, to: 0, curve: 'easeIn', intensity: 2.5 });
  });

  it('multistage: add, reorder and remove phases; coast phase is described', () => {
    const out: { form?: FormState } = {};
    render(<Harness initial={load('stage-coast')} onForm={(n) => { out.form = n; }} />);
    const n = load('stage-coast').phases.length;
    expect(screen.getByText('Coast phase: no control is desired.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add phase' }));
    expect(out.form!.phases).toHaveLength(n + 1);
    fireEvent.click(screen.getByRole('button', { name: `Move phase ${n + 1} up` }));
    expect(out.form!.phases[n - 1]!.targets.throttle).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Remove phase ${n + 1}` }));
    expect(out.form!.phases).toHaveLength(n);
  });

  it('places a core error on the matching field (aria-invalid) and shows the message', () => {
    const out: { form?: FormState } = {};
    render(<Harness initial={load('hold-brake-40')} msg="phases[0].targets.brake.from: 2 outside [0,1]" onForm={(n) => { out.form = n; }} />);
    const field = screen.getByLabelText(/Brake hold/);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByText(/2 outside \[0,1\]/)).toHaveLength(1);
  });

  it('tolerance: difficulty and per-control/per-drill overrides', () => {
    const out: { form?: FormState } = {};
    render(<Harness initial={load('stage-bs')} onForm={(n) => { out.form = n; }} />);
    fireEvent.change(screen.getByLabelText('Difficulty'), { target: { value: 'advanced' } });
    fireEvent.change(screen.getByLabelText(/Drill tolerance override/), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/Steering tolerance override/), { target: { value: '3' } });
    expect(buildDrill(out.form!)).toMatchObject({ difficulty: 'advanced', tolerance: 0.04, controlTolerance: { steering: 0.03 } });
  });
});
