import { useId, useMemo, useState } from 'react';
import './results.css';
import { fmtNum, linePath, ticks, unitShort } from './chartMath';
import type { Axis } from '../../input/types';
import type { Metric, Recommendation, RoundResult, SessionResults } from '../../wasm/sessionBridge';

const AXES: Axis[] = ['brake', 'steering', 'throttle'];
// Fixed y domains so every panel/round is comparable point for point. Brake/throttle 0..100 %; steering signed %, provisional.
const Y: Record<Axis, [number, number]> = { brake: [0, 100], throttle: [0, 100], steering: [-100, 100] };
const UNIT: Record<Axis, string> = { brake: '%', throttle: '%', steering: 'signed % (provisional)' };
const roundLabel = (r: RoundResult) => `Round ${r.round}, attempt ${r.attempt} - ${r.outcome}`;
const slot = (r: RoundResult) => `var(--series-${((r.round - 1) % 8) + 1})`;
const pct = (v: number | null | undefined) => (v == null ? null : v * 100);

type XMode = 'time' | 'norm';
type Line = { key: string; label: string; xs: number[]; ys: (number | null)[]; kind: 'actual' | 'desired'; color?: string; testid?: string };
type Zoom = { lo: number; hi: number };

/** Build plot series for one round/axis. Never mutates inputs; invalid frames become null (gaps). */
function roundLines(r: RoundResult, axis: Axis, mode: XMode, filtered: boolean): { lines: Line[]; note?: string; domain: [number, number]; norm: boolean; byDuration?: boolean } | null {
  const sh = r.shape?.[axis];
  if (mode === 'norm' && sh) {
    return { lines: [
      { key: 'd', label: 'Desired (shape)', xs: sh.u, ys: sh.desired.map((v) => v * 100), kind: 'desired', testid: `path-${axis}-desired` },
      { key: 'a', label: 'Actual', xs: sh.u, ys: sh.actual.map(pct), kind: 'actual', testid: `path-${axis}-actual` },
    ], note: filtered ? 'Filtered trace is not available in the normalized view; showing raw.' : undefined, domain: [0, 1], norm: true };
  }
  const tr = r.display[axis];
  if (!tr) return null;
  const src = filtered && tr.filtered ? tr.filtered : tr.actual;
  const byDuration = mode === 'norm' && r.durationMs > 0;
  const xs = tr.t.map((t) => (byDuration ? t / r.durationMs : t / 1000));
  const lines: Line[] = [];
  if (tr.desired) lines.push({ key: 'd', label: 'Desired', xs, ys: tr.desired.map(pct), kind: 'desired', testid: `path-${axis}-desired` });
  lines.push({ key: 'a', label: 'Actual', xs, ys: src.map((v, i) => (tr.valid[i] ? pct(v) : null)), kind: 'actual', testid: `path-${axis}-actual` });
  return { lines, note: filtered && !tr.filtered ? 'No filtered trace for this channel; showing raw.' : undefined, norm: byDuration, byDuration,
    domain: byDuration ? [0, Math.max(1, ...xs)] : [0, Math.max(r.durationMs / 1000, ...xs, 0.001)] };
}

function Chart(p: { axis: Axis; lines: Line[]; domain: [number, number]; zoom: Zoom; xLabel: string; phases?: RoundResult['phases']; title: string; width?: number }) {
  const { axis, lines, domain, zoom, xLabel, phases, title } = p;
  const clip = useId();
  const W = 640, H = 150, L = 52, R = 12, T = 8, B = 30;
  const span = domain[1] - domain[0];
  const x0 = domain[0] + zoom.lo * span, x1 = domain[0] + zoom.hi * span;
  const sx = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const [y0, y1] = Y[axis];
  const sy = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const fmtX = (v: number) => (span <= 1.0001 && domain[1] === 1 ? v.toFixed(2) : v.toFixed(1));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${clip}-t ${clip}-d`}>
      <title id={`${clip}-t`}>{title}</title>
      <desc id={`${clip}-d`}>{`Retrospective plot of ${axis} in ${UNIT[axis]} against ${xLabel}, from ${fmtX(x0)} to ${fmtX(x1)}. Dashed line is desired, solid is actual. Gaps are unavailable samples. A data table is available.`}</desc>
      <defs><clipPath id={clip}><rect x={L} y={T} width={W - L - R} height={H - T - B} /></clipPath></defs>
      {ticks(y0, y1, 2).map((v) => (
        <g key={v}><line className="grid" x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} /><text x={L - 6} y={sy(v) + 4} textAnchor="end">{v}</text></g>
      ))}
      {ticks(x0, x1, 4).map((v) => (<text key={v} x={sx(v)} y={H - 14} textAnchor="middle">{fmtX(v)}</text>))}
      <text x={(L + W - R) / 2} y={H - 2} textAnchor="middle">{xLabel}</text>
      <g clipPath={`url(#${clip})`}>
        {phases?.map((ph) => (
          <g key={ph.index}><line className="phase" x1={sx(ph.startMs / 1000)} x2={sx(ph.startMs / 1000)} y1={T} y2={H - B} /><text x={sx(ph.startMs / 1000) + 3} y={T + 10}>{ph.name ?? `phase ${ph.index + 1}`}</text></g>
        ))}
        {lines.map((l) => (
          <path key={l.key} className={l.kind} data-testid={l.testid} style={l.kind === 'actual' ? { stroke: l.color ?? 'var(--series-1)' } : undefined} d={linePath(l.xs, l.ys, sx, sy)} />
        ))}
      </g>
    </svg>
  );
}

function DataTable({ caption, lines, zoom, domain }: { caption: string; lines: Line[]; zoom: Zoom; domain: [number, number] }) {
  const lo = domain[0] + zoom.lo * (domain[1] - domain[0]), hi = domain[0] + zoom.hi * (domain[1] - domain[0]);
  const cell = (v: number | null | undefined) => (v == null ? 'gap' : fmtNum(v));
  // each series has its own x column: series may be sampled at different coordinates, never assume simultaneity
  const n = Math.max(...lines.map((l) => l.xs.length));
  const idx = Array.from({ length: n }, (_, i) => i);
  const inWin = (l: Line, i: number) => i < l.xs.length && l.xs[i] >= lo && l.xs[i] <= hi;
  return (
    <table><caption>{caption}</caption>
      <thead><tr>{lines.map((l) => <th key={l.key} colSpan={2}>{l.label}</th>)}</tr>
        <tr>{lines.map((l) => <><th key={l.key + 'x'}>x</th><th key={l.key + 'y'}>value</th></>)}</tr></thead>
      <tbody>{idx.map((i) => lines.some((l) => inWin(l, i)) ? (
        <tr key={i}>{lines.map((l) => inWin(l, i) ? <><td key={l.key + 'x'}>{fmtNum(l.xs[i])}</td><td key={l.key + 'y'}>{cell(l.ys[i])}</td></> : <><td key={l.key + 'x'}></td><td key={l.key + 'y'}></td></>)}</tr>) : null)}</tbody>
    </table>
  );
}

const direction = (better: string) =>
  better === 'lower' ? 'lower is better' : better === 'higher' ? 'higher is better' : '0 is ideal (signed; closer to 0 is better)';

function MetricCell({ m, details }: { m?: Metric; details: boolean }) {
  if (!m) return <td>-</td>;
  const meta = `${direction(m.better)} · ${m.coverage == null ? 'coverage unknown' : `coverage ${Math.round(m.coverage * 100)}%`} · ${m.formulaVersion}`;
  if (!m.applicable || m.value == null)
    return <td title={meta}><span className="na">{`N/A — ${m.reason ?? 'not applicable'}`}</span>{details && <small>{meta}</small>}</td>;
  return (
    <td title={meta}>{fmtNum(m.value)} {unitShort(m.unit)}{m.coverage != null && m.coverage < 0.8 && ' (low coverage)'}{details && <small>{meta}</small>}</td>
  );
}

const mkey = (m: Metric) => `${m.id}|${m.axis ?? ''}`;

function MetricTable({ title, cols, pick, details }: { title: string; cols: RoundResult[]; pick: (r: RoundResult) => Metric[]; details: boolean }) {
  const rows = useMemo(() => {
    const seen = new Map<string, Metric>();
    for (const r of cols) for (const m of pick(r)) if (!seen.has(mkey(m))) seen.set(mkey(m), m);
    return [...seen.values()];
  }, [cols, pick]);
  return (
    <section>
      <h3>{title}</h3>
      {rows.length === 0 ? <p>No {title.toLowerCase()} metrics.</p> : (
        <table><thead><tr><th>Metric</th>{cols.map((r) => <th key={`${r.round}.${r.attempt}`}>R{r.round}.{r.attempt}</th>)}</tr></thead>
          <tbody>{rows.map((row) => (
            <tr key={mkey(row)}><th scope="row">{row.label}{row.axis ? ` (${row.axis})` : ''}</th>
              {cols.map((r) => <MetricCell key={`${r.round}.${r.attempt}`} m={pick(r).find((m) => mkey(m) === mkey(row))} details={details} />)}</tr>
          ))}</tbody></table>
      )}
    </section>
  );
}

function Spark({ label, unit, better, vals }: { label: string; unit: string; better: string; vals: (number | null)[] }) {
  const id = useId();
  const nums = vals.filter((v): v is number => v != null);
  if (!nums.length) return null;
  let lo = Math.min(...nums), hi = Math.max(...nums);
  if (lo === hi) { lo -= 1; hi += 1; }
  const W = 160, H = 48, sx = (i: number) => 8 + (i * (W - 16)) / Math.max(vals.length - 1, 1), sy = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * (H - 12);
  const xs = vals.map((_, i) => i);
  const d = linePath(xs, vals, sx, sy);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}t ${id}d`}>
        <title id={`${id}t`}>{`${label} per round`}</title>
        <desc id={`${id}d`}>{vals.map((v, i) => `round ${i + 1}: ${v == null ? 'no value' : fmtNum(v)}`).join('; ')}</desc>
        <path className="actual" d={d} style={{ stroke: 'var(--series-1)' }} />
        {vals.map((v, i) => (v == null ? null : <circle key={i} cx={sx(i)} cy={sy(v)} r={3} fill="var(--series-1)" />))}
      </svg>
      <figcaption><small>{label} ({unitShort(unit) || 'count'}, {direction(better)}); range {fmtNum(Math.min(...nums))} to {fmtNum(Math.max(...nums))}</small></figcaption>
    </figure>
  );
}

function Recs({ recs, onApply }: { recs: Recommendation[]; onApply?: (r: Recommendation) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  return (
    <section>
      <h3>Suggestions</h3>
      <p><small>Suggestions only, based on this session. Nothing changes unless you apply it.</small></p>
      {recs.length === 0 ? <p>No suggestions.</p> : (
        <ul>{recs.map((r) => (
          <li key={r.id}>{r.text}
            {r.change && onApply && pending !== r.id && <> <button type="button" onClick={() => setPending(r.id)}>Apply to next session</button></>}
            {r.change && onApply && pending === r.id && (
              <div className="confirm" role="alertdialog" aria-label="Confirm change">
                Change {r.change.path} from {JSON.stringify(r.change.from)} to {JSON.stringify(r.change.to)} for the next session?{' '}
                <button type="button" onClick={() => { onApply(r); setPending(null); }}>Confirm apply</button>{' '}
                <button type="button" onClick={() => setPending(null)}>Cancel</button>
              </div>
            )}
          </li>))}
        </ul>
      )}
    </section>
  );
}

export function ResultsView({ results, onApplyRecommendation }: { results: SessionResults; onApplyRecommendation?: (rec: Recommendation) => void }) {
  const [idx, setIdx] = useState(0);
  const [filtered, setFiltered] = useState(false);
  const [mode, setMode] = useState<XMode>('norm');
  const [zoom, setZoom] = useState<Zoom>({ lo: 0, hi: 1 });
  const [table, setTable] = useState(false);
  const [details, setDetails] = useState(false);
  const [ovAxis, setOvAxis] = useState<Axis>('brake');
  const [ovMode, setOvMode] = useState<XMode>('time');
  const [ovRounds, setOvRounds] = useState<number[]>([]);
  const rounds = results.rounds;
  const round = rounds[Math.min(idx, rounds.length - 1)];

  const level = Math.round(1 / (zoom.hi - zoom.lo));
  const zoomTo = (f: number) => setZoom((z) => {
    const span = Math.min(1, Math.max(1 / 16, (z.hi - z.lo) * f)), c = (z.lo + z.hi) / 2;
    const lo = Math.min(Math.max(c - span / 2, 0), 1 - span);
    return { lo, hi: lo + span };
  });
  const pan = (dir: number) => setZoom((z) => {
    const s = z.hi - z.lo, lo = Math.min(Math.max(z.lo + dir * s * 0.25, 0), 1 - s);
    return { lo, hi: lo + s };
  });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === '+' || e.key === '=') zoomTo(0.5);
    else if (e.key === '-') zoomTo(2);
    else if (e.key === 'ArrowLeft') pan(-1);
    else if (e.key === 'ArrowRight') pan(1);
    else if (e.key === '0') setZoom({ lo: 0, hi: 1 });
    else return;
    e.preventDefault();
  };

  const eff: XMode = round?.selfPaced ? mode : 'time';
  const panels = round ? AXES.map((a) => ({ axis: a, data: roundLines(round, a, eff, filtered) })) : [];
  const isNorm = (a: Axis) => !!panels.find((p) => p.axis === a)?.data?.norm;

  // overlay series
  const ov = ovRounds.map((i) => rounds[i]).filter(Boolean).flatMap((r) => {
    const d = roundLines(r, ovAxis, ovMode, filtered);
    if (!d) return [];
    const a = d.lines.find((l) => l.kind === 'actual')!;
    return [{ r, byDuration: d.byDuration, domain: d.domain, line: { ...a, key: `o${r.round}.${r.attempt}`, label: `Round ${r.round}.${r.attempt}`, color: slot(r), testid: `overlay-path-r${r.round}` } as Line, desired: d.lines.find((l) => l.kind === 'desired') }];
  });
  const ovDomain: [number, number] = [0, Math.max(...ov.map((o) => o.domain[1]), ovMode === 'norm' ? 1 : 0.001)];
  const ovDesired = ov.find((o) => o.desired)?.desired;
  const ovLines: Line[] = [...(ovDesired ? [{ ...ovDesired, label: 'Desired (first selected round)' }] : []), ...ov.map((o) => o.line)];

  // trends: first metric per category/axis, matched by id across rounds
  const trends = useMemo(() => {
    const out: { label: string; unit: string; better: string; vals: (number | null)[] }[] = [];
    const seen = new Set<string>();
    for (const cat of ['accuracy', 'smoothness', 'timing'] as const)
      for (const r of rounds) for (const m of r[cat]) {
        const k = `${cat}|${m.axis ?? ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ label: `${cat} - ${m.label}${m.axis ? ` (${m.axis})` : ''}`, unit: m.unit, better: m.better,
          vals: rounds.map((rr) => { const x = rr[cat].find((y) => mkey(y) === mkey(m)); return x && x.applicable ? x.value : null; }) });
      }
    return out;
  }, [rounds]);

  const pickers = useMemo(() => ({ accuracy: (r: RoundResult) => r.accuracy, smoothness: (r: RoundResult) => r.smoothness, timing: (r: RoundResult) => r.timing }), []);

  if (!round) return <section className="results"><h2>Results</h2><p>No rounds recorded.</p></section>;
  const xLabel = (a: Axis) => (isNorm(a) ? (panels.find((p) => p.axis === a)?.data?.byDuration ? 'Progress (normalized by round duration)' : 'Progress (normalized over measured round duration)') : 'Time (s)');

  return (
    <section className="results" aria-label="Session results">
      <h2>Results</h2>
      <p><small>These graphs are retrospective review only; they are not needed while driving. Data stays in this page and is discarded on reset or reload.</small></p>

      <div className="controls">
        <label>Round <select value={idx} onChange={(e) => { setIdx(Number(e.target.value)); setZoom({ lo: 0, hi: 1 }); }}>
          {rounds.map((r, i) => <option key={i} value={i}>{roundLabel(r)}</option>)}</select></label>
        <label><input type="checkbox" checked={filtered} onChange={(e) => setFiltered(e.target.checked)} /> Show filtered trace</label>
        <span role="status" aria-label="Trace source">{filtered ? 'Showing filtered input (smoothing used for the smoothness metric)' : 'Showing raw input'}</span>
        {round.selfPaced && (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="sr-only" style={{ position: 'absolute', left: '-9999px' }}>Horizontal axis</legend>
            <label><input type="radio" name="xmode" checked={mode === 'norm'} onChange={() => setMode('norm')} /> Normalized progress</label>{' '}
            <label><input type="radio" name="xmode" checked={mode === 'time'} onChange={() => setMode('time')} /> Raw time</label></fieldset>)}
      </div>

      <div role="group" aria-label="Input charts" tabIndex={0} onKeyDown={onKey}>
        <div className="controls">
          <button type="button" onClick={() => zoomTo(0.5)}>Zoom in</button>
          <button type="button" onClick={() => zoomTo(2)}>Zoom out</button>
          <button type="button" onClick={() => pan(-1)}>Pan left</button>
          <button type="button" onClick={() => pan(1)}>Pan right</button>
          <button type="button" onClick={() => setZoom({ lo: 0, hi: 1 })}>Reset zoom</button>
          <span role="status" aria-label="Zoom">Zoom {level}x</span>
          <small>Keys when focused: + - zoom, arrows pan, 0 reset</small>
        </div>
        <div className="legend"><span><i className="sw dashed" />Desired (dashed)</span><span><i className="sw" style={{ color: 'var(--series-1)' }} />Actual (solid)</span><span>Gaps mean no valid sample</span></div>
        {panels.map(({ axis, data }) => data ? (
          <div key={axis}>
            <h3>{axis[0].toUpperCase() + axis.slice(1)} <small style={{ display: 'inline' }}>({UNIT[axis]})</small></h3>
            {data.note && <small>{data.note}</small>}
            <Chart axis={axis} lines={data.lines} domain={data.domain} zoom={zoom} xLabel={xLabel(axis)}
              phases={isNorm(axis) ? undefined : round.phases} title={`${axis} ${data.lines.some((l) => l.kind === 'desired') ? 'desired vs actual' : 'actual'}, ${roundLabel(round)}`} />
            {table && <DataTable caption={`${axis} values, ${roundLabel(round)}`} lines={data.lines} zoom={zoom} domain={data.domain} />}
          </div>
        ) : <p key={axis}>{axis[0].toUpperCase() + axis.slice(1)}: no data for this round.</p>)}
      </div>
      <label><input type="checkbox" checked={table} onChange={(e) => setTable(e.target.checked)} /> Show data table</label>

      <h3>Compare rounds (one channel)</h3>
      <div className="controls">
        <label>Channel <select value={ovAxis} onChange={(e) => setOvAxis(e.target.value as Axis)}>{AXES.map((a) => <option key={a}>{a}</option>)}</select></label>
        <label><input type="radio" name="ovmode" checked={ovMode === 'time'} onChange={() => setOvMode('time')} /> Time (s)</label>
        <label><input type="radio" name="ovmode" checked={ovMode === 'norm'} onChange={() => setOvMode('norm')} /> Normalized progress</label>
        {rounds.map((r, i) => (
          <label key={i}><input type="checkbox" aria-label={`Overlay round ${r.round}${r.attempt > 1 ? ` attempt ${r.attempt}` : ''}`} checked={ovRounds.includes(i)}
            onChange={(e) => setOvRounds((s) => (e.target.checked ? [...s, i] : s.filter((x) => x !== i)))} /> R{r.round}.{r.attempt}</label>))}
      </div>
      {ov.length > 0 && (
        <>
          <div className="legend">{ov.map((o) => <span key={o.line.key}><i className="sw" style={{ color: o.line.color }} />{o.line.label}</span>)}</div>
          <Chart axis={ovAxis} lines={ovLines} domain={ovDomain} zoom={zoom} xLabel={ovMode === 'norm' ? (ov.some((o) => o.byDuration) ? 'Progress (normalized by round duration)' : 'Progress (normalized over measured round duration)') : 'Time (s)'} title={`${ovAxis} overlay of ${ov.length} rounds`} />
          {table && <DataTable caption={`${ovAxis} overlay values`} lines={ovLines} zoom={zoom} domain={ovDomain} />}
        </>
      )}

      <h2>Metrics</h2>
      <p><small>Each measure is reported separately. There is no combined total. N/A means the measure does not apply.</small></p>
      <label><input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} /> Show metric details (direction, coverage, formula)</label>
      <MetricTable title="Accuracy" cols={rounds} pick={pickers.accuracy} details={details} />
      <MetricTable title="Smoothness" cols={rounds} pick={pickers.smoothness} details={details} />
      <MetricTable title="Timing" cols={rounds} pick={pickers.timing} details={details} />
      <section><h3>Consistency</h3>
        <table><thead><tr><th>Metric (whole session)</th><th>Value</th></tr></thead>
          <tbody>{results.consistency.map((m) => <tr key={mkey(m)}><th scope="row">{m.label}{m.axis ? ` (${m.axis})` : ''}</th><MetricCell m={m} details={details} /></tr>)}</tbody></table>
      </section>

      <h3>Session trends</h3>
      <div className="trends">{trends.map((t) => <Spark key={t.label} {...t} />)}</div>

      <Recs recs={results.recommendations} onApply={onApplyRecommendation} />
    </section>
  );
}
