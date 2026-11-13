// Package metrics computes the post-session results (spec 3.6, 7; R-024..
// R-027): separate accuracy, smoothness, timing and consistency metrics per
// round and axis, the traces to plot them, and suggestion-only
// recommendations. There is deliberately no composite score. Pure and
// deterministic; formulas are documented in docs/metric-definitions.md and
// versioned (FormulaVersion), expected values pinned in testdata.
package metrics

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"

	"github.com/arush-sal/trail-braking-trainer/core/drills"
	"github.com/arush-sal/trail-braking-trainer/core/input"
	"github.com/arush-sal/trail-braking-trainer/core/session"
)

// Formula versions; bump on any change to a formula's result.
const (
	AccuracyVersion   = "accuracy/v1"
	SmoothnessVersion = "smoothness/v2"
	// CoverageVersion is the coverage rule gating every per-round metric.
	CoverageVersion    = "coverage/v2"
	TimingVersion      = "timing/v1"
	ConsistencyVersion = "consistency/v1"
)

// Parameters. All PROPOSED (to be tuned with hardware test data).
const (
	// MinCoverage: below this fraction of expected samples an axis's
	// metrics are N/A.
	MinCoverage = 0.9
	// MaxSmoothIntervalMs: smoothness needs at least MinSmoothTime of the
	// round covered by valid-sample intervals no longer than this (20 Hz):
	// tremor of up to ~8 Hz needs at least ~16 Hz to be seen at all.
	MaxSmoothIntervalMs = 50.0
	MinSmoothTime       = 0.9
	// PeakExclusionMs: reversals this close to a desired direction change
	// (a desired peak at a phase boundary) are intended, not counted.
	PeakExclusionMs = 100.0
	// ReversalMin is the swing (normalized, on top of the noise floor) a
	// direction change needs to count as a reversal.
	ReversalMin = 0.02
	// EndpointWindowMs is the final window averaged for endpoint error.
	EndpointWindowMs = 250.0
	// OnsetMin is the offset from a ramp's start/end level (on top of the
	// noise floor) that defines onset/arrival crossings for timing.
	OnsetMin = 0.02
	// MaxDisplayPoints bounds each display trace.
	MaxDisplayPoints = 1000
)

// Series is a sample series; NaN marshals as null (a gap, never 0).
type Series []float64

// MarshalJSON writes NaN/Inf as null.
func (s Series) MarshalJSON() ([]byte, error) {
	b := append(make([]byte, 0, 2+8*len(s)), '[')
	for i, v := range s {
		if i > 0 {
			b = append(b, ',')
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			b = append(b, "null"...)
		} else {
			b = strconv.AppendFloat(b, v, 'g', -1, 64)
		}
	}
	return append(b, ']'), nil
}

// UnmarshalJSON reads null as NaN.
func (s *Series) UnmarshalJSON(b []byte) error {
	var ps []*float64
	if err := json.Unmarshal(b, &ps); err != nil {
		return err
	}
	*s = make(Series, len(ps))
	for i, p := range ps {
		(*s)[i] = math.NaN()
		if p != nil {
			(*s)[i] = *p
		}
	}
	return nil
}

// Trace is one axis of one attempt, on active time (pauses excluded).
type Trace struct {
	T        []float64 `json:"t"`
	Actual   Series    `json:"actual"`
	Filtered Series    `json:"filtered,omitempty"`
	Desired  Series    `json:"desired,omitempty"`
	Valid    []bool    `json:"valid"`
}

// ShapeTrace is the self-paced retrospective comparison on normalized
// progress u = t / measured duration.
type ShapeTrace struct {
	U       []float64 `json:"u"`
	Actual  Series    `json:"actual"`
	Desired []float64 `json:"desired"`
}

// Metric is one separate measure; never combined into a total.
type Metric struct {
	ID             string     `json:"id"`
	Label          string     `json:"label"`
	Axis           input.Axis `json:"axis,omitempty"`
	Value          *float64   `json:"value"`
	Unit           string     `json:"unit"`
	Better         string     `json:"better"` // lower | higher | n/a
	Applicable     bool       `json:"applicable"`
	Reason         string     `json:"reason,omitempty"`
	Coverage       *float64   `json:"coverage,omitempty"`
	FormulaVersion string     `json:"formulaVersion"`
}

// PhaseMark is a desired phase boundary on active time (timed drills).
type PhaseMark struct {
	Index   int     `json:"index"`
	Name    string  `json:"name,omitempty"`
	StartMs float64 `json:"startMs"`
}

// RoundResult is one attempt.
type RoundResult struct {
	Round      int                        `json:"round"`
	Attempt    int                        `json:"attempt"`
	Outcome    string                     `json:"outcome"`
	SelfPaced  bool                       `json:"selfPaced"`
	DurationMs float64                    `json:"durationMs"`
	Phases     []PhaseMark                `json:"phases"`
	Traces     map[input.Axis]Trace       `json:"traces,omitempty"` // full resolution; only with includeFull (api.Runner.Results)
	Display    map[input.Axis]Trace       `json:"display"`
	Shape      map[input.Axis]*ShapeTrace `json:"shape,omitempty"`
	Accuracy   []Metric                   `json:"accuracy"`
	Smoothness []Metric                   `json:"smoothness"`
	Timing     []Metric                   `json:"timing"`

	shapeMs float64
	scored  map[input.Axis]bool
}

// Change is a suggested edit the UI may offer to apply on user confirmation.
type Change struct {
	Path string `json:"path"`
	From any    `json:"from"`
	To   any    `json:"to"`
}

// Recommendation is a suggestion only; it is never applied automatically.
type Recommendation struct {
	ID     string  `json:"id"`
	Text   string  `json:"text"`
	Change *Change `json:"change,omitempty"`
}

// SessionResults is the results contract (docs/results-contract.md).
type SessionResults struct {
	APIVersion      int                     `json:"apiVersion"`
	Mode            string                  `json:"mode"`
	Drill           *drills.DrillDefinition `json:"drill,omitempty"`
	Rounds          []RoundResult           `json:"rounds"`
	Consistency     []Metric                `json:"consistency"`
	Recommendations []Recommendation        `json:"recommendations"`
	Error           string                  `json:"error,omitempty"`
}

// Input is everything Analyze needs; it is only read.
type Input struct {
	Drill      *drills.DrillDefinition // nil = freeform
	Controls   []input.Axis
	Attempts   []session.Attempt
	SelfPaced  bool // freeform self-paced session (guided reads Drill.Timing)
	NoiseFloor float64
}

// Analyze computes the results of the given finished attempts.
func Analyze(in Input) SessionResults {
	res := SessionResults{APIVersion: 1, Mode: "freeform", Rounds: []RoundResult{}}
	var d *drills.DrillDefinition
	if in.Drill != nil {
		dd := in.Drill.WithDefaults()
		d, res.Mode, res.Drill = &dd, "guided", &dd
	}
	tries := map[int]int{}
	for _, a := range in.Attempts {
		tries[a.Round]++
		res.Rounds = append(res.Rounds, analyzeRound(in, d, a, tries[a.Round]))
	}
	res.Consistency = consistency(res.Rounds, in.Controls)
	res.Recommendations = recommend(d, res.Rounds)
	return res
}

// coverage (coverage/v2) is effective valid samples / expected samples.
// Expected = floor(dur/dt)+1 with dt the median frame interval. A sample
// counts only if it is at least dt/2 after the last counted one, so bursts
// (0,1,100,101,... ms) cannot hide blind intervals.
func coverage(ts []float64, dur, dt float64) float64 {
	if !(dur > 0 && dt > 0) || len(ts) == 0 {
		return 0
	}
	n, last := 1, ts[0]
	for _, t := range ts[1:] {
		if t-last >= dt/2 {
			n, last = n+1, t
		}
	}
	return min(1, float64(n)/(math.Floor(dur/dt)+1))
}

// blindFraction is the fraction of [0,dur] lying in intervals between
// valid samples (and the round's start/end) longer than maxMs.
func blindFraction(ts []float64, dur, maxMs float64) float64 {
	if dur <= 0 {
		return 1
	}
	edges := append(append([]float64{0}, ts...), dur)
	var blind float64
	for i := 1; i < len(edges); i++ {
		if g := edges[i] - edges[i-1]; g > maxMs {
			blind += g
		}
	}
	return min(1, blind/dur)
}

func completed(o session.Outcome) bool {
	return o == session.OutcomeCompletedTimed || o == session.OutcomeCompletedAuto || o == session.OutcomeCompletedManual
}

func ok(id, label string, a input.Axis, v float64, unit, better, ver string) Metric {
	m := Metric{ID: id, Label: label, Axis: a, Unit: unit, Better: better, FormulaVersion: ver}
	if math.IsNaN(v) || math.IsInf(v, 0) {
		m.Reason = "no valid samples"
		return m
	}
	m.Value, m.Applicable = &v, true
	return m
}

func notApp(id, label string, a input.Axis, unit, better, ver, reason string) Metric {
	return Metric{ID: id, Label: label, Axis: a, Unit: unit, Better: better, FormulaVersion: ver, Reason: reason}
}

// gate attaches coverage and turns metrics N/A when reason is set.
func gate(ms []Metric, cov float64, reason string) []Metric {
	for i := range ms {
		c := cov
		ms[i].Coverage = &c
		if reason != "" {
			ms[i].Value, ms[i].Applicable, ms[i].Reason = nil, false, reason
		}
	}
	return ms
}

func totalMs(d *drills.DrillDefinition) float64 {
	var t float64
	for _, p := range d.Phases {
		t += p.DurationMs
	}
	return t
}

// activeTimes maps frame times onto attempt active time (pauses removed).
// ponytail: O(frames x pauses), pauses capped at 256 per attempt.
func activeTimes(a session.Attempt) []float64 {
	out := make([]float64, len(a.Frames))
	for i, f := range a.Frames {
		t := f.ReceivedMonoMs - a.StartMs
		for _, p := range a.Paused {
			if p.EndMs <= f.ReceivedMonoMs {
				t -= p.EndMs - p.StartMs
			}
		}
		out[i] = t
	}
	return out
}

func sample(f input.Frame, a input.Axis) float64 {
	var m input.Measurement
	switch a {
	case input.AxisBrake:
		m = f.Brake
	case input.AxisSteering:
		m = f.Steering
	default:
		m = f.Throttle
	}
	if !m.Available || m.Normalized == nil || f.Quality.Gap || f.Quality.Stale {
		return math.NaN()
	}
	return *m.Normalized
}

// round holds the per-attempt time base shared by every axis.
type round struct {
	d         *drills.DrillDefinition
	timed     bool
	frames    []input.Frame
	ts        []float64
	dt        float64   // median frame interval
	shapeMs   float64   // self-paced: measured shape duration
	span      float64   // drill length on active time (timed total or shapeMs)
	span0     float64   // attempt active duration
	bounds    []float64 // internal phase boundaries, active ms
	noise     float64
	notScored string
}

// desiredAt is the time-aligned (timed) or normalized-time (self-paced)
// desired value; NaN for freeform.
func (r *round) desiredAt(a input.Axis, t float64) float64 {
	switch {
	case r.d == nil:
		return math.NaN()
	case r.timed:
		s, _ := drills.TargetAt(*r.d, t)
		return s.Values[a]
	case r.shapeMs <= 0:
		return math.NaN()
	}
	return drills.ShapeAt(*r.d, min(t/r.shapeMs, 1)).Values[a]
}

func analyzeRound(in Input, d *drills.DrillDefinition, a session.Attempt, try int) RoundResult {
	timed := d != nil && d.Timing == drills.Timed
	selfPaced := (d != nil && !timed) || (d == nil && in.SelfPaced)
	dur := a.EndMs - a.StartMs - a.PausedMs
	rr := RoundResult{
		Round: a.Round, Attempt: try, Outcome: string(a.Outcome), SelfPaced: selfPaced, DurationMs: dur,
		Phases: []PhaseMark{}, Traces: map[input.Axis]Trace{}, Display: map[input.Axis]Trace{},
		Accuracy: []Metric{}, Smoothness: []Metric{}, Timing: []Metric{}, scored: map[input.Axis]bool{},
	}
	r := &round{d: d, timed: timed, frames: a.Frames, ts: activeTimes(a), shapeMs: dur, span0: dur, noise: in.NoiseFloor}
	var diffs []float64
	for i := 1; i < len(r.ts); i++ {
		diffs = append(diffs, r.ts[i]-r.ts[i-1])
	}
	r.dt = median(diffs)
	if !completed(a.Outcome) {
		r.notScored = fmt.Sprintf("attempt %s: not scored (never counted as a success)", a.Outcome)
	}
	if d != nil {
		if !timed && a.Outcome == session.OutcomeCompletedAuto {
			// The trailing completion hold confirms the end state; it is
			// not part of the executed shape (docs/metric-definitions.md).
			r.shapeMs = dur - d.CompletionHoldMsFor()
		}
		span := r.shapeMs
		if timed {
			span = totalMs(d)
		}
		r.span = span
		for i, f := range drills.PhaseStarts(*d) {
			if timed {
				rr.Phases = append(rr.Phases, PhaseMark{Index: i, Name: d.Phases[i].Name, StartMs: f * span})
			}
			if i > 0 {
				r.bounds = append(r.bounds, f*span)
			}
		}
	}
	rr.shapeMs = r.shapeMs
	for _, ax := range in.Controls {
		r.axis(&rr, ax, dur)
	}
	switch {
	case d == nil:
		rr.Accuracy = []Metric{notApp("accuracy", "Target accuracy", "", "pp", "n/a", AccuracyVersion, "freeform: there is no target to compare against")}
		rr.Timing = []Metric{notApp("timing", "Timing", "", "s", "n/a", TimingVersion, "freeform: there is no desired timeline")}
	case selfPaced:
		rr.Timing = []Metric{notApp("timing", "Timing", "", "s", "n/a", TimingVersion, "self-paced: duration is reported descriptively (durationMs), never scored as timing")}
		if len(d.Phases) > 1 {
			rr.Accuracy = append(rr.Accuracy, notApp("accuracy.coordination", "Relative coordination", "", "pp", "lower", AccuracyVersion,
				"no documented primary-control progress parameter exists yet (spec 3.4); phases are compared on normalized time only"))
		}
	}
	return rr
}

func (r *round) axis(rr *RoundResult, ax input.Axis, dur float64) {
	n := len(r.ts)
	tr := Trace{T: r.ts, Actual: make(Series, n), Filtered: make(Series, n), Valid: make([]bool, n)}
	var ts, vs []float64
	var idx []int
	for i, fr := range r.frames {
		f := sample(fr, ax)
		tr.Actual[i] = f
		tr.Valid[i] = !math.IsNaN(f)
		if tr.Valid[i] {
			ts, vs, idx = append(ts, r.ts[i]), append(vs, f), append(idx, i)
		}
	}
	tps := turningPoints(vs, ReversalMin+r.noise)
	trend := monotoneTrend(vs, tps)
	for i := range tr.Filtered {
		tr.Filtered[i] = math.NaN()
	}
	for j, i := range idx {
		tr.Filtered[i] = trend[j]
	}
	if r.timed {
		tr.Desired = make(Series, n)
		for i, t := range r.ts {
			tr.Desired[i] = r.desiredAt(ax, t)
		}
	}
	rr.Traces[ax] = tr
	rr.Display[ax] = downsample(tr, MaxDisplayPoints)

	cov := coverage(ts, dur, r.dt)
	reason := r.notScored
	if reason == "" && cov < MinCoverage {
		reason = fmt.Sprintf("sample coverage %.2f < %.2f", cov, MinCoverage)
	}
	rr.scored[ax] = reason == ""
	if r.d != nil {
		if !r.timed && rr.scored[ax] && r.shapeMs > 0 {
			st := &ShapeTrace{}
			for j, t := range ts {
				if t <= r.shapeMs {
					st.U, st.Actual, st.Desired = append(st.U, t/r.shapeMs), append(st.Actual, vs[j]), append(st.Desired, r.desiredAt(ax, t))
				}
			}
			if rr.Shape == nil {
				rr.Shape = map[input.Axis]*ShapeTrace{}
			}
			rr.Shape[ax] = st
		}
		rr.Accuracy = append(rr.Accuracy, gate(r.accuracy(ax, ts, vs, dur), cov, reason)...)
	}
	rr.Smoothness = append(rr.Smoothness, gate(r.smoothness(ax, ts, vs, trend, tps), cov, reason)...)
	if r.timed {
		rr.Timing = append(rr.Timing, gate(r.timing(ax, ts, vs), cov, reason)...)
	}
}

func (r *round) accuracy(ax input.Axis, ts, vs []float64, dur float64) []Metric {
	tol := r.d.ToleranceFor(ax)
	lbl := ""
	if !r.timed {
		lbl = " (normalized-duration shape)"
	}
	// Self-paced ids are accuracy.shapeMae etc., so a shape value is never
	// mistaken for a time-aligned one.
	id := func(s string) string {
		if r.timed {
			return "accuracy." + s
		}
		return map[string]string{"mae": "accuracy.shapeMae", "p95": "accuracy.shapeP95", "bias": "accuracy.shapeBias", "withinTolerance": "accuracy.shapeWithinTolerance"}[s]
	}
	var abs, signed, end []float64
	in := 0
	w := min(EndpointWindowMs, 0.1*dur)
	for j, t := range ts {
		e := vs[j] - r.desiredAt(ax, t)
		if t >= dur-w {
			end = append(end, e)
		}
		if !r.timed && t > r.shapeMs {
			continue
		}
		abs, signed = append(abs, math.Abs(e)), append(signed, e)
		if math.Abs(e) <= tol+1e-12 {
			in++
		}
	}
	var out []Metric
	if len(abs) == 0 || (!r.timed && r.shapeMs <= 0) {
		reason := "no valid samples"
		if !r.timed && r.shapeMs <= 0 {
			reason = "measured shape duration is not positive"
		}
		for _, s := range []string{"mae", "p95", "bias", "withinTolerance"} {
			out = append(out, notApp(id(s), s, ax, "pp", "lower", AccuracyVersion, reason))
		}
	} else {
		out = append(out,
			ok(id("mae"), "Mean absolute error"+lbl, ax, 100*mean(abs), "pp", "lower", AccuracyVersion),
			ok(id("p95"), "95th percentile absolute error"+lbl, ax, 100*p95(abs), "pp", "lower", AccuracyVersion),
			ok(id("bias"), "Bias, mean signed error (+ above target, 0 ideal)"+lbl, ax, 100*mean(signed), "pp", "n/a", AccuracyVersion),
			ok(id("withinTolerance"), fmt.Sprintf("Fraction of samples within tolerance (%.3g)%s", tol, lbl), ax, float64(in)/float64(len(abs)), "fraction", "higher", AccuracyVersion))
	}
	if len(end) == 0 {
		out = append(out, notApp("accuracy.endpoint", "Endpoint error", ax, "pp", "lower", AccuracyVersion, "no valid samples in the final window"))
	} else {
		out = append(out, ok("accuracy.endpoint", fmt.Sprintf("Endpoint error (mean over final %.0f ms)", w), ax, 100*math.Abs(mean(end)), "pp", "lower", AccuracyVersion))
	}
	const ptID, ptLabel = "accuracy.phaseTransition", "Error at phase boundaries"
	var pe []float64
	for _, b := range r.bounds {
		if v := interp(ts, vs, b, 2*r.dt); !math.IsNaN(v) {
			pe = append(pe, math.Abs(v-r.desiredAt(ax, b)))
		}
	}
	switch {
	case len(r.bounds) == 0:
		out = append(out, notApp(ptID, ptLabel, ax, "pp", "lower", AccuracyVersion, "single phase: no internal phase boundary"))
	case len(pe) < len(r.bounds):
		out = append(out, notApp(ptID, ptLabel, ax, "pp", "lower", AccuracyVersion, fmt.Sprintf("no valid sample at %d of %d phase boundaries", len(r.bounds)-len(pe), len(r.bounds))))
	default:
		out = append(out, ok(ptID, ptLabel, ax, 100*mean(pe), "pp", "lower", AccuracyVersion))
	}
	return out
}

// phaseOf is the desired phase owning active time t.
func (r *round) phaseOf(t float64) int {
	p := 0
	for _, b := range r.bounds {
		if t >= b {
			p++
		}
	}
	return p
}

// segment classifies a time as hold/ramp (guided) or all (freeform).
func (r *round) segment(ax input.Axis, t float64) string {
	switch {
	case r.d == nil:
		return "all"
	case !r.timed && t > r.shapeMs:
		return "hold" // completion hold
	}
	if rp := r.d.Phases[r.phaseOf(t)].Targets[ax]; rp.From != rp.To {
		return "ramp"
	}
	return "hold"
}

// intendedReversals returns, per desired direction change of ax, the
// window (from the end of one ramp to the start of the next opposite ramp,
// widened by PeakExclusionMs) in which one actual reversal is intended.
func (r *round) intendedReversals(ax input.Axis) [][2]float64 {
	var out [][2]float64
	starts := append([]float64{0}, r.bounds...)
	lastDir, lastEnd := 0, 0.0
	for k, p := range r.d.Phases {
		rp := p.Targets[ax]
		if rp.From == rp.To {
			continue
		}
		if dir := sign(rp.To - rp.From); lastDir != 0 && dir != lastDir {
			out = append(out, [2]float64{lastEnd - PeakExclusionMs, starts[k] + PeakExclusionMs})
		}
		lastDir, lastEnd = sign(rp.To-rp.From), r.span
		if k+1 < len(starts) {
			lastEnd = starts[k+1]
		}
	}
	return out
}

func (r *round) smoothness(ax input.Axis, ts, vs, trend []float64, tps []int) []Metric {
	kinds := []string{"hold", "ramp"}
	if r.d == nil {
		kinds = []string{"all"}
	}
	ex, spike := map[string][]float64{}, map[string]float64{}
	for j, t := range ts {
		k := r.segment(ax, t)
		ex[k] = append(ex[k], max(0, math.Abs(vs[j]-trend[j])-r.noise))
		spike[k] = max(spike[k], spikeAt(ts, vs, j)-r.noise)
	}
	rev := map[string]int{}
	var intended [][2]float64
	if r.d != nil {
		intended = r.intendedReversals(ax)
	}
	used := make([]bool, len(intended))
tps:
	for _, i := range tps {
		for w, iv := range intended {
			if !used[w] && ts[i] >= iv[0] && ts[i] <= iv[1] {
				used[w] = true // the one reversal the drill asks for
				continue tps
			}
		}
		rev[r.segment(ax, ts[i])]++
	}
	var out []Metric
	for _, k := range kinds {
		if len(ex[k]) == 0 {
			continue
		}
		jid, sid, rid := "smoothness."+k+".jitter", "smoothness."+k+".spike", "smoothness."+k+".reversals"
		jl := "Jitter: RMS residual to the monotone movement trend, above noise floor (" + k + ")"
		sl := "Largest isolated spike (1-2 sample outlier vs both local trends), above noise floor (" + k + ")"
		rl := "Direction reversals above noise floor (" + k + ")"
		if longFrac := blindFraction(ts, r.span0, MaxSmoothIntervalMs); longFrac > 1-MinSmoothTime {
			reason := fmt.Sprintf("%.0f%% of the round has sample intervals > %.0f ms: sample rate too low to judge smoothness", 100*longFrac, MaxSmoothIntervalMs)
			out = append(out, notApp(jid, jl, ax, "pp", "lower", SmoothnessVersion, reason), notApp(sid, sl, ax, "pp", "lower", SmoothnessVersion, reason), notApp(rid, rl, ax, "count", "lower", SmoothnessVersion, reason))
			continue
		}
		var sq float64
		for _, e := range ex[k] {
			sq += e * e
		}
		out = append(out,
			ok(jid, jl, ax, 100*math.Sqrt(sq/float64(len(ex[k]))), "pp", "lower", SmoothnessVersion),
			ok(sid, sl, ax, 100*spike[k], "pp", "lower", SmoothnessVersion),
			ok(rid, rl, ax, float64(rev[k]), "count", "lower", SmoothnessVersion))
	}
	return out
}

// rampTime is when the desired ramp first reaches level (bisection on
// its monotone curve), in active ms.
func rampTime(rp drills.Ramp, start, durMs, level float64) float64 {
	dir := float64(sign(rp.To - rp.From))
	lo, hi := 0.0, 1.0
	for range 60 {
		m := (lo + hi) / 2
		if dir*(rp.At(m)-level) >= 0 {
			hi = m
		} else {
			lo = m
		}
	}
	return start + hi*durMs
}

func (r *round) timing(ax input.Axis, ts, vs []float64) []Metric {
	const (
		sID, sL = "timing.startDelay", "Start delay at first desired movement (+ late, - early)"
		eID, eL = "timing.endDelay", "End delay at arrival of last desired movement (+ late, - early)"
		pID, pL = "timing.phaseTransition", "Mean |deviation| of mid-transition crossings"
	)
	var onset, mid, arrive []*float64
	fracs, total := drills.PhaseStarts(*r.d), totalMs(r.d)
	for k, p := range r.d.Phases {
		rp := p.Targets[ax]
		if rp.From == rp.To {
			continue
		}
		dir := sign(rp.To - rp.From)
		th := min(math.Abs(rp.To-rp.From)/2, OnsetMin+r.noise)
		start, win := fracs[k]*total, max(1000, p.DurationMs)
		at := func(level float64) *float64 {
			want := rampTime(rp, start, p.DurationMs, level)
			got, found := crossing(ts, vs, level, dir, want, win, 2*r.dt)
			if !found {
				return nil
			}
			d := (got - want) / 1000
			return &d
		}
		onset = append(onset, at(rp.From+float64(dir)*th))
		mid = append(mid, at((rp.From+rp.To)/2))
		arrive = append(arrive, at(rp.To-float64(dir)*th))
	}
	if len(mid) == 0 {
		const why = "no desired movement on this axis (hold): see accuracy"
		return []Metric{notApp(sID, sL, ax, "s", "n/a", TimingVersion, why), notApp(eID, eL, ax, "s", "n/a", TimingVersion, why), notApp(pID, pL, ax, "s", "lower", TimingVersion, why)}
	}
	one := func(id, label string, v *float64) Metric {
		if v == nil {
			return notApp(id, label, ax, "s", "n/a", TimingVersion, "actual input did not cross the landmark level near the desired time")
		}
		return ok(id, label, ax, *v, "s", "n/a", TimingVersion)
	}
	out := []Metric{one(sID, sL, onset[0]), one(eID, eL, arrive[len(arrive)-1])}
	var devs []float64
	for _, m := range mid {
		if m != nil {
			devs = append(devs, math.Abs(*m))
		}
	}
	if len(devs) < len(mid) {
		return append(out, notApp(pID, pL, ax, "s", "lower", TimingVersion, fmt.Sprintf("actual input missed %d of %d transitions", len(mid)-len(devs), len(mid))))
	}
	return append(out, ok(pID, pL, ax, mean(devs), "s", "lower", TimingVersion))
}

// landmarks are the normalized-time points compared across rounds.
var landmarks = []float64{0.25, 0.5, 0.75, 1}

func consistency(rounds []RoundResult, controls []input.Axis) []Metric {
	var valid []RoundResult
	for _, r := range rounds {
		if completed(session.Outcome(r.Outcome)) {
			valid = append(valid, r)
		}
	}
	if len(valid) < 2 {
		return []Metric{notApp("consistency", "Consistency across rounds", "", "", "lower", ConsistencyVersion,
			fmt.Sprintf("needs >= 2 valid rounds, got %d", len(valid)))}
	}
	type key struct {
		id string
		ax input.Axis
	}
	var order []key
	vals, meta := map[key][]float64{}, map[key]Metric{}
	for _, r := range valid {
		for _, m := range slices.Concat(r.Accuracy, r.Smoothness, r.Timing) {
			k := key{m.ID, m.Axis}
			if _, seen := meta[k]; !seen {
				order, meta[k] = append(order, k), m
			}
			if m.Applicable && m.Value != nil {
				vals[k] = append(vals[k], *m.Value)
			}
		}
	}
	var out []Metric
	for _, k := range order {
		if len(vals[k]) == 0 {
			continue // structurally N/A (e.g. self-paced timing): nothing to spread
		}
		m, id := meta[k], "consistency."+k.id
		label := "Spread (std) across rounds of: " + m.Label
		if v := vals[k]; len(v) >= 2 {
			out = append(out, ok(id, label, k.ax, std(v), m.Unit, "lower", ConsistencyVersion))
		} else {
			out = append(out, notApp(id, label, k.ax, m.Unit, "lower", ConsistencyVersion, "needs >= 2 valid rounds where this metric applies"))
		}
	}
	for _, ax := range controls {
		var sds []float64
		for _, f := range landmarks {
			var vs []float64
			for _, r := range valid {
				if !r.scored[ax] || r.shapeMs <= 0 {
					continue
				}
				tr := r.Traces[ax]
				var ts, xs, diffs []float64
				for i, ok := range tr.Valid {
					if ok {
						ts, xs = append(ts, tr.T[i]), append(xs, tr.Actual[i])
					}
				}
				for i := 1; i < len(ts); i++ {
					diffs = append(diffs, ts[i]-ts[i-1])
				}
				if v := interp(ts, xs, f*r.shapeMs, 2*median(diffs)); !math.IsNaN(v) {
					vs = append(vs, v)
				}
			}
			if len(vs) >= 2 {
				sds = append(sds, std(vs))
			}
		}
		const id, label = "consistency.trajectory", "Mean spread (std) of the actual trace at 25/50/75/100% of the round"
		if len(sds) == 0 {
			out = append(out, notApp(id, label, ax, "pp", "lower", ConsistencyVersion, "needs >= 2 valid rounds with coverage"))
		} else {
			out = append(out, ok(id, label, ax, 100*mean(sds), "pp", "lower", ConsistencyVersion))
		}
	}
	return out
}

var ladder = []drills.Difficulty{drills.Beginner, drills.Intermediate, drills.Advanced}

func recommend(d *drills.DrillDefinition, rounds []RoundResult) []Recommendation {
	out := []Recommendation{}
	lost, valid := 0, 0
	var within []float64
	perAxis := map[input.Axis]int{}
	for _, r := range rounds {
		if r.Outcome == string(session.OutcomeInvalidSourceLost) {
			lost++
		}
		if !completed(session.Outcome(r.Outcome)) {
			continue
		}
		valid++
		for _, m := range r.Accuracy {
			if (m.ID == "accuracy.withinTolerance" || m.ID == "accuracy.shapeWithinTolerance") && m.Applicable {
				within = append(within, *m.Value)
				perAxis[m.Axis]++
			}
		}
	}
	eligible := d != nil
	if eligible {
		for _, a := range d.Controls {
			eligible = eligible && perAxis[a] >= 2 // >= 2 scorable rounds on every axis
		}
	}
	if eligible {
		overrides := d.Tolerance != 0 || len(d.ControlTolerance) > 0
		i := slices.Index(ladder, d.Difficulty)
		switch {
		case slices.Min(within) > 0.95:
			text := fmt.Sprintf("Within tolerance more than 95%% of the time on every axis in every scorable round (%d completed).", valid)
			switch {
			case !overrides && i >= 0 && i+1 < len(ladder):
				out = append(out, Recommendation{ID: "difficulty.harder", Text: text + fmt.Sprintf(" Consider the %s preset.", ladder[i+1]),
					Change: &Change{Path: "difficulty", From: d.Difficulty, To: ladder[i+1]}})
			case overrides:
				out = append(out, Recommendation{ID: "tolerance.tighter", Text: text + " Consider a tighter tolerance."})
			}
		case mean(within) < 0.5:
			text := fmt.Sprintf("Within tolerance less than half of the time on average over the scorable rounds (%d completed).", valid)
			switch {
			case !overrides && i > 0:
				out = append(out, Recommendation{ID: "difficulty.easier", Text: text + fmt.Sprintf(" Consider the %s preset.", ladder[i-1]),
					Change: &Change{Path: "difficulty", From: d.Difficulty, To: ladder[i-1]}})
			default:
				out = append(out, Recommendation{ID: "tolerance.wider", Text: text + " Consider a wider tolerance or slower phases."})
			}
		}
	}
	if lost > 0 {
		out = append(out, Recommendation{ID: "source.lost", Text: fmt.Sprintf("%d attempt(s) ended because the input source was lost; check the connection before comparing rounds.", lost)})
	}
	return out
}
