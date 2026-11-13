export type Scale = (v: number) => number;

/** SVG path for a series; null/non-finite y values BREAK the line (a gap), they are never drawn as 0. */
export function linePath(xs: number[], ys: (number | null | undefined)[], sx: Scale, sy: Scale): string {
  let d = '';
  let run: string[] = [];
  const flush = () => {
    if (run.length === 1) d += `${run[0]}L${run[0].slice(1)}`; // lone sample: zero-length segment, round cap shows a dot
    else if (run.length > 1) d += run[0] + run.slice(1).map((p) => 'L' + p.slice(1)).join('');
    run = [];
  };
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y == null || !Number.isFinite(y) || !Number.isFinite(xs[i])) flush();
    else run.push(`M${sx(xs[i]).toFixed(1)},${sy(y).toFixed(1)}`);
  }
  flush();
  return d;
}

export const ticks = (lo: number, hi: number, n = 4): number[] =>
  Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);

export const fmtNum = (v: number): string => {
  const s = v.toFixed(Math.abs(v) >= 100 ? 0 : 1);
  const t = s.endsWith('.0') ? s.slice(0, -2) : s;
  return t === '-0' ? '0' : t; // a rounded tiny negative is not 'minus zero'
};

export const unitWords = (u: string): string => (u === 'pp' ? 'percentage points' : u === 's' ? 'seconds' : u === 'count' ? '' : u);
export const unitShort = (u: string): string => (u === 'pp' ? 'pp' : u === 'count' ? '' : u);
