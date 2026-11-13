// Plain-SVG setup preview (spec 3.4). The curve math lives in Go: samples come from an injected
// previewSamples(def, n) (bridge), never recomputed here.
import type { Axis } from '../../input/types';
import type { DrillDefinition } from '../../wasm/sessionBridge';

export type PreviewData = {
  apiVersion: number;
  timed: boolean;
  /** ms (timed) or normalized progress u in [0,1] (self-paced). */
  x: number[];
  values: Partial<Record<Axis, number[]>>;
  phases: { index: number; startX: number }[];
};
export type PreviewSamples = (def: DrillDefinition, n: number) => PreviewData;

const W = 320, H = 160, PAD = 28;
// Distinct dash patterns as well as colours so the lines are not told apart by colour alone.
const STYLE: Record<Axis, { stroke: string; dash?: string; label: string }> = {
  brake: { stroke: '#ff6b6b', label: 'Brake' },
  steering: { stroke: '#ffd166', dash: '6 3', label: 'Steering (provisional scale)' },
  throttle: { stroke: '#4ade80', dash: '2 3', label: 'Throttle' },
};

export function SetupPreview({ def, previewSamples, points = 64 }: { def: DrillDefinition; previewSamples?: PreviewSamples; points?: number }) {
  if (!previewSamples) return <p>Preview unavailable: the core sampler is not connected.</p>;
  const p = previewSamples(def, points);
  const axes = def.controls.filter((a) => p.values[a]);
  const signed = axes.includes('steering');
  const xmax = Math.max(...p.x, 1e-9);
  const [lo, hi] = signed ? [-1, 1] : [0, 1];
  const px = (x: number) => PAD + ((W - PAD - 6) * x) / xmax;
  const py = (v: number) => H - PAD - ((H - PAD - 6) * (v - lo)) / (hi - lo);
  const summary = axes.map((a) => `${STYLE[a].label} from ${Math.round(p.values[a]![0]! * 100)}% to ${Math.round(p.values[a]!.at(-1)! * 100)}%`).join('; ');
  const xLabel = p.timed ? `Time (s), 0 to ${(xmax / 1000).toFixed(1)}` : 'Normalized progress (0 to 1, round time scaled)';
  return (
    <figure className="drill-preview">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Desired targets: ${summary}`} width="100%">
        <rect x={PAD} y={6} width={W - PAD - 6} height={H - PAD - 6} fill="none" stroke="#8a93a5" />
        {signed && <line x1={PAD} x2={W - 6} y1={py(0)} y2={py(0)} stroke="#8a93a5" strokeDasharray="1 3" />}
        {p.phases.slice(1).map((ph) => <line key={ph.index} x1={px(ph.startX)} x2={px(ph.startX)} y1={6} y2={H - PAD} stroke="#586075" />)}
        {axes.map((a) => (
          <polyline key={a} fill="none" strokeWidth={2.5} stroke={STYLE[a].stroke} strokeDasharray={STYLE[a].dash}
            points={p.x.map((x, i) => `${px(x).toFixed(1)},${py(p.values[a]![i]!).toFixed(1)}`).join(' ')} />
        ))}
        <text x={PAD - 4} y={py(hi) + 4} fill="#b8bfcc" fontSize="9" textAnchor="end">{hi * 100}%</text>
        <text x={PAD - 4} y={py(lo) + 4} fill="#b8bfcc" fontSize="9" textAnchor="end">{lo * 100}%</text>
      </svg>
      <figcaption>
        {xLabel}. {axes.map((a) => STYLE[a].label).join(', ')}. {summary}.
        {!p.timed && ' Self-paced: this is the desired shape only; there is no live desired target during the round.'}
      </figcaption>
    </figure>
  );
}
