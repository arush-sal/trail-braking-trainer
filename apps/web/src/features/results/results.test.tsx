import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ResultsView } from './ResultsView';
import { linePath } from './chartMath';
import { summaryText } from './summaryText';
import { fixture } from './fixtures';

afterEach(cleanup);
const count = (s: string, ch: string) => s.split(ch).length - 1;

describe('linePath', () => {
  const id = (v: number) => v;
  it('breaks the path at null values and never draws them as zero', () => {
    const d = linePath([0, 1, 2, 3, 4], [1, 2, null, 3, 4], id, id);
    expect(count(d, 'M')).toBe(2);
    expect(d).not.toMatch(/ 0(\s|$)/);
  });
  it('is empty when no samples', () => expect(linePath([0, 1], [null, null], id, id)).toBe(''));
});

describe('ResultsView', () => {
  it('every charted channel has a desired and an actual path with stable test ids', () => {
    render(<ResultsView results={fixture()} />);
    expect(screen.getByTestId('path-brake-desired').getAttribute('d')).toMatch(/^M/);
    expect(screen.getByTestId('path-brake-actual').getAttribute('d')).toMatch(/^M/);
  });

  it('renders invalid sample as a gap in the actual path', () => {
    render(<ResultsView results={fixture()} />);
    const d = screen.getByTestId('path-brake-actual').getAttribute('d')!;
    expect(count(d, 'M')).toBe(2);
  });
  it('labels every round with outcome incl. invalid and shows retrospective note', () => {
    render(<ResultsView results={fixture()} />);
    const opts = within(screen.getByLabelText(/round/i, { selector: 'select' })).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toHaveLength(3);
    expect(opts[2]).toMatch(/invalid/);
    expect(screen.getAllByText(/retrospective/i).length).toBeGreaterThan(0);
  });
  it('toggles raw vs filtered with clear label', () => {
    render(<ResultsView results={fixture()} />);
    expect(screen.getByText(/showing raw input/i)).toBeTruthy();
    const before = screen.getByTestId('path-brake-actual').getAttribute('d');
    fireEvent.click(screen.getByRole('checkbox', { name: /filtered/i }));
    expect(screen.getByText(/showing filtered input/i)).toBeTruthy();
    expect(screen.getByTestId('path-brake-actual').getAttribute('d')).not.toBe(before);
  });
  it('shows missing channel as unavailable, not zero', () => {
    render(<ResultsView results={fixture()} />);
    expect(screen.getByText(/steering: no data/i)).toBeTruthy();
  });
  it('renders N/A with reason and never 100%', () => {
    const { container } = render(<ResultsView results={fixture()} />);
    expect(screen.getByText(/N\/A — self-paced drill has no clock/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/100\s?%/);
  });
  it('has no composite score/grade anywhere', () => {
    const { container } = render(<ResultsView results={fixture()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /metric details/i }));
    const texts = [container.textContent ?? ''];
    container.querySelectorAll('[title],[aria-label]').forEach((e) => texts.push(e.getAttribute('title') ?? '', e.getAttribute('aria-label') ?? ''));
    expect(texts.join(' ')).not.toMatch(/score|grade|overall/i);
  });
  it('signed metrics (bias, delays) say 0 is ideal instead of a direction', () => {
    render(<ResultsView results={fixture()} />);
    expect(screen.getAllByTitle(/0 is ideal/).length).toBeGreaterThan(0);
  });

  it('shows metric details: direction, coverage, formula version', () => {
    render(<ResultsView results={fixture()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /metric details/i }));
    expect(screen.getAllByText(/lower is better/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/accuracy\/v1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/coverage 95%/).length).toBeGreaterThan(0);
  });
  it('groups metrics and shows consistency for the session', () => {
    render(<ResultsView results={fixture()} />);
    for (const h of ['Accuracy', 'Smoothness', 'Timing', 'Consistency']) expect(screen.getByRole('heading', { name: h })).toBeTruthy();
  });
  it('apply recommendation requires explicit click and confirm', () => {
    const apply = vi.fn();
    const r = fixture();
    render(<ResultsView results={r} onApplyRecommendation={apply} />);
    expect(screen.getAllByRole('button', { name: /apply to next session/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /apply to next session/i }));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /apply to next session/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm apply/i }));
    expect(apply).toHaveBeenCalledWith(r.recommendations[0]);
  });
  it('self-paced uses normalized progress label, with raw time option', () => {
    render(<ResultsView results={fixture()} />);
    fireEvent.change(screen.getByLabelText(/^round/i, { selector: 'select' }), { target: { value: '1' } });
    expect(screen.getAllByText(/normalized over measured round duration/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('radio', { name: /raw time/i }));
    expect(screen.queryByText(/normalized over measured round duration/i)).toBeNull();
    expect(screen.getAllByText(/time \(s\)/i).length).toBeGreaterThan(0);
  });
  it('overlays selected rounds for one channel', () => {
    render(<ResultsView results={fixture()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /overlay round 1/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /overlay round 2/i }));
    expect(screen.getByTestId('overlay-path-r1')).toBeTruthy();
    expect(screen.getByTestId('overlay-path-r2')).toBeTruthy();
  });
  it('zoom in/out/reset via buttons and keyboard', () => {
    render(<ResultsView results={fixture()} />);
    expect(screen.getByRole('status', { name: /zoom/i }).textContent).toMatch(/1x/);
    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(screen.getByRole('status', { name: /zoom/i }).textContent).toMatch(/2x/);
    fireEvent.keyDown(screen.getByRole('group', { name: /input charts/i }), { key: '+' });
    expect(screen.getByRole('status', { name: /zoom/i }).textContent).toMatch(/4x/);
    fireEvent.keyDown(screen.getByRole('group', { name: /input charts/i }), { key: '-' });
    expect(screen.getByRole('status', { name: /zoom/i }).textContent).toMatch(/2x/);
    fireEvent.click(screen.getByRole('button', { name: /reset zoom/i }));
    expect(screen.getByRole('status', { name: /zoom/i }).textContent).toMatch(/1x/);
  });
  it('offers a data table fallback with gaps spelled out', () => {
    render(<ResultsView results={fixture()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /data table/i }));
    expect(screen.getAllByText('gap').length).toBeGreaterThan(0);
  });
  it('charts have title and desc', () => {
    const { container } = render(<ResultsView results={fixture()} />);
    const svg = container.querySelector('svg[role="img"]')!;
    expect(svg.querySelector('title')?.textContent).toBeTruthy();
    expect(svg.querySelector('desc')?.textContent).toBeTruthy();
  });
  it('renders session trends and does not mutate input', () => {
    const r = fixture();
    const copy = structuredClone(r);
    render(<ResultsView results={r} />);
    expect(screen.getByRole('heading', { name: /session trends/i })).toBeTruthy();
    expect(r).toEqual(copy);
  });
});

describe('overlay fixes', () => {
  it('normalizes rounds without shape by round duration, with an honest label', () => {
    render(<ResultsView results={fixture()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /overlay round 1/i }));
    fireEvent.click(screen.getByRole('radio', { name: /normalized progress/i, checked: false }));
    expect(screen.getAllByText(/normalized by round duration/i).length).toBeGreaterThan(0);
    // round 1: t=400ms of 400ms duration => last x at 1.00, not 0.4 seconds
    fireEvent.click(screen.getByRole('checkbox', { name: /data table/i }));
    const tbl = screen.getByText(/brake overlay values/i).closest('table')!;
    expect(tbl.textContent).toMatch(/1(?!\.)/);
    expect(tbl.textContent).not.toMatch(/0\.4(?!\d)/);
  });
  it('overlay table gives each series its own coordinates', () => {
    render(<ResultsView results={fixture()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /overlay round 1/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /overlay round 2/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /data table/i }));
    const tbl = screen.getByText(/brake overlay values/i).closest('table')!;
    const heads = [...tbl.querySelectorAll('thead tr:nth-child(2) th')].map((h) => h.textContent);
    expect(heads.filter((h) => h === 'x').length).toBeGreaterThanOrEqual(3);
    // round 2 is sampled at 1 s, 2 s, 3 s; its row 2 must show x=1 beside value 50, not round 1's 0.1 s
    const row = [...tbl.querySelectorAll('tbody tr')][1].textContent!;
    expect(row).toMatch(/0\.1/);
    expect(row).toMatch(/1.*50/);
  });
});

describe('summaryText', () => {
  it('summarises a round', () => {
    const t = summaryText(fixture(), 1);
    expect(t).toMatch(/round 1/i);
    expect(t).toMatch(/brake/i);
    expect(t).toMatch(/4\.2 points/);
    expect(t).not.toMatch(/score|grade|overall/i);
  });
  it('says timing not applicable', () => {
    expect(summaryText(fixture(), 2)).toMatch(/timing is not applicable/i);
  });
  it('summarises the session including consistency', () => {
    const t = summaryText(fixture());
    expect(t).toMatch(/3 rounds/);
    expect(t).toMatch(/spread of mean error/i);
  });
  it('counts every completed outcome and speaks outcomes in words', () => {
    expect(summaryText(fixture())).toMatch(/3 rounds, 2 completed/);
    expect(summaryText(fixture(), 1)).toMatch(/^Round 1: completed\./);
    expect(summaryText(fixture(), 3)).toMatch(/invalid, input source lost/);
    expect(summaryText(fixture(), 3)).not.toMatch(/invalidSourceLost/);
  });
  it('stays short enough to hear eyes-free: per axis mean error, named start delay, mean-error consistency only', () => {
    const r = fixture();
    const extra = (id: string, axis: 'brake' | 'steering' | 'throttle', value: number, unit = 's') =>
      ({ id, label: `long label for ${id}`, axis, value, unit, better: 'n/a' as const, applicable: true, formulaVersion: 'v1' });
    r.rounds[0]!.timing = [extra('timing.startDelay', 'brake', -0.04), extra('timing.endDelay', 'brake', 0.2), extra('timing.phaseTransition', 'brake', 0.1)];
    r.rounds[0]!.smoothness.push(extra('smoothness.hold.jitter', 'brake', 0.4, 'pp'));
    r.consistency.push(extra('consistency.accuracy.p95', 'brake', 9, 'pp'), extra('consistency.smoothness.hold.jitter', 'brake', 1, 'pp'));
    const round = summaryText(r, 1);
    expect(round).toBe('Round 1: completed. Brake mean error 4.2 points, start delay 0 seconds. Throttle mean error 1.5 points.');
    const session = summaryText(r);
    expect(session).toBe('Session finished: 3 rounds, 2 completed. Round to round spread of mean error: brake 1.2 points. 2 suggestions on screen.');
  });
  it('explains consistency unavailable', () => {
    const r = fixture();
    r.consistency = [{ ...r.consistency[0], applicable: false, value: null, reason: 'needs 2 valid rounds' }];
    expect(summaryText(r)).toMatch(/consistency is not available/i);
  });
});
