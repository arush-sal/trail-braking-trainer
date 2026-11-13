package metrics

import (
	"math"
	"slices"
	"sort"
)

// Signal helpers. Every series here is the valid samples only (sorted
// times ts, values vs); invalid samples never enter a computation.

// pava is the least-squares non-decreasing fit of v (pool adjacent
// violators).
func pava(v []float64) []float64 {
	type block struct {
		sum float64
		n   int
	}
	var st []block
	for _, x := range v {
		st = append(st, block{x, 1})
		for k := len(st) - 1; k > 0 && st[k-1].sum*float64(st[k].n) > st[k].sum*float64(st[k-1].n); k-- {
			st[k-1] = block{st[k-1].sum + st[k].sum, st[k-1].n + st[k].n}
			st = st[:k]
		}
	}
	out := make([]float64, 0, len(v))
	for _, b := range st {
		for range b.n {
			out = append(out, b.sum/float64(b.n))
		}
	}
	return out
}

// monotoneTrend splits the valid samples at the turning points into runs
// and fits each run with its best monotone (non-decreasing or
// non-increasing) least-squares trend. Intended motion of any speed or
// curvature between direction changes is monotone and has zero residual.
func monotoneTrend(vs []float64, tps []int) []float64 {
	out := make([]float64, 0, len(vs))
	start := 0
	for _, end := range append(slices.Clone(tps), len(vs)-1) {
		if end < start {
			continue
		}
		run := vs[start : end+1]
		up := pava(run)
		neg := make([]float64, len(run))
		for i, x := range run {
			neg[i] = -x
		}
		down := pava(neg)
		var su, sd float64
		for i, x := range run {
			su += (x - up[i]) * (x - up[i])
			sd += (x + down[i]) * (x + down[i])
		}
		for i := range run {
			if su <= sd {
				out = append(out, up[i])
			} else {
				out = append(out, -down[i])
			}
		}
		start = end + 1
	}
	return out
}

// spikeAt is how far sample i departs from BOTH local linear trends: the
// one extrapolated from the two samples before it and the one from the two
// samples after it (the smaller deviation). Any sampled trajectory that
// keeps a consistent slope on at least one side - including a fast
// intended 0 -> 1 -> 0 reversal - scores 0; a one- or two-sample outlier
// that returns to the prior level does not. 0 within two samples of an end.
func spikeAt(ts, vs []float64, i int) float64 {
	if i < 2 || i+2 >= len(vs) {
		return 0
	}
	ext := func(t0, v0, t1, v1 float64) float64 { return v1 + (v1-v0)*(ts[i]-t1)/(t1-t0) }
	l := ext(ts[i-2], vs[i-2], ts[i-1], vs[i-1])
	r := ext(ts[i+2], vs[i+2], ts[i+1], vs[i+1])
	return min(math.Abs(vs[i]-l), math.Abs(vs[i]-r))
}

// turningPoints is a zig-zag filter: it returns the sample indices of
// direction reversals whose swing is at least th on both sides. A
// monotonic move of any speed has none; one up-then-down move has one.
func turningPoints(vs []float64, th float64) []int {
	var out []int
	if len(vs) == 0 {
		return out
	}
	dir, ext, start := 0, 0, vs[0]
	for i, v := range vs {
		switch {
		case dir == 0 && math.Abs(v-start) >= th:
			dir, ext = sign(v-start), i
		case dir != 0 && float64(dir)*(v-vs[ext]) > 0:
			ext = i
		case dir != 0 && float64(dir)*(vs[ext]-v) >= th:
			out = append(out, ext)
			dir, ext = -dir, i
		}
	}
	return out
}

func sign(x float64) int {
	if x < 0 {
		return -1
	}
	return 1
}

// interp returns the value at t by linear interpolation between the valid
// samples around it, or NaN when t falls in a hole longer than maxGap or
// outside the samples by more than maxGap.
func interp(ts, vs []float64, t, maxGap float64) float64 {
	i := sort.SearchFloat64s(ts, t)
	switch {
	case i < len(ts) && ts[i] == t:
		return vs[i]
	case i == 0:
		if len(ts) > 0 && ts[0]-t <= maxGap {
			return vs[0]
		}
	case i == len(ts):
		if t-ts[i-1] <= maxGap {
			return vs[i-1]
		}
	case ts[i]-ts[i-1] <= maxGap:
		return vs[i-1] + (vs[i]-vs[i-1])*(t-ts[i-1])/(ts[i]-ts[i-1])
	}
	return math.NaN()
}

// crossing returns the time, nearest to want and within +/- window, at
// which the valid samples cross level in direction dir (interpolated).
func crossing(ts, vs []float64, level float64, dir int, want, window, maxGap float64) (float64, bool) {
	best, found := 0.0, false
	d := float64(dir)
	for i := 1; i < len(ts); i++ {
		a, b := d*(vs[i-1]-level), d*(vs[i]-level)
		if !(a < 0 && b >= 0) || ts[i]-ts[i-1] > maxGap {
			continue
		}
		t := ts[i-1] + (ts[i]-ts[i-1])*(-a)/(b-a)
		if math.Abs(t-want) <= window && (!found || math.Abs(t-want) < math.Abs(best-want)) {
			best, found = t, true
		}
	}
	return best, found
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return math.NaN()
	}
	s := slices.Sorted(slices.Values(xs))
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// p95 is the nearest-rank 95th percentile.
func p95(xs []float64) float64 {
	s := slices.Sorted(slices.Values(xs))
	return s[int(math.Ceil(0.95*float64(len(s))))-1]
}

func mean(xs []float64) float64 {
	var t float64
	for _, x := range xs {
		t += x
	}
	return t / float64(len(xs))
}

// std is the sample standard deviation (n-1).
func std(xs []float64) float64 {
	m := mean(xs)
	var ss float64
	for _, x := range xs {
		ss += (x - m) * (x - m)
	}
	return math.Sqrt(ss / float64(len(xs)-1))
}

// downsample keeps at most limit points of a trace for plotting: both ends
// plus, per bucket, the minimum and maximum actual sample and its gap
// (min-max bucketing), so spikes and gaps stay visible. A bucket with two
// or more separate gaps is shown as unavailable (one null point), so no
// plotted line ever bridges missing data. The original trace is untouched.
func downsample(tr Trace, limit int) Trace {
	n := len(tr.T)
	if n <= limit {
		return tr
	}
	buckets := (limit - 2) / 3
	keep := []int{0}
	for b := range buckets {
		lo, hi := b*n/buckets, (b+1)*n/buckets
		mn, mx, gap, runs := -1, -1, -1, 0
		for i := lo; i < hi; i++ {
			v := tr.Actual[i]
			switch {
			case math.IsNaN(v):
				if i == lo || !math.IsNaN(tr.Actual[i-1]) {
					runs++
				}
				if gap < 0 {
					gap = i
				}
			default:
				if mn < 0 || v < tr.Actual[mn] {
					mn = i
				}
				if mx < 0 || v > tr.Actual[mx] {
					mx = i
				}
			}
		}
		if runs > 1 {
			mn, mx = -1, -1 // unavailable bucket
		}
		for _, i := range []int{mn, mx, gap} {
			if i >= 0 {
				keep = append(keep, i)
			}
		}
	}
	keep = append(keep, n-1)
	slices.Sort(keep)
	keep = slices.Compact(keep)
	pick := func(s []float64) []float64 {
		if s == nil {
			return nil
		}
		out := make([]float64, len(keep))
		for j, i := range keep {
			out[j] = s[i]
		}
		return out
	}
	valid := make([]bool, len(keep))
	for j, i := range keep {
		valid[j] = tr.Valid[i]
	}
	return Trace{T: pick(tr.T), Actual: pick(tr.Actual), Filtered: pick(tr.Filtered), Desired: pick(tr.Desired), Valid: valid}
}
