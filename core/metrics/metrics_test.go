package metrics

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/drills"
	"github.com/arush-sal/trail-braking-trainer/core/input"
	"github.com/arush-sal/trail-braking-trainer/core/session"
)

// Synthetic trace fixtures (spec 11.1), built on the real input.Frame
// contract and the real drills targets, sampled every stepMs.

var update = flag.Bool("update", false, "rewrite testdata/fixtures_v1.json")

const (
	stepMs = 10.0
	B      = input.AxisBrake
	S      = input.AxisSteering
	T      = input.AxisThrottle
)

var na = math.NaN()

func meas(v float64) input.Measurement {
	if math.IsNaN(v) {
		return input.Measurement{RawUnit: "none"}
	}
	return input.Measurement{Available: true, RawValue: &v, RawUnit: "ratio", Normalized: &v}
}

func frame(t, b, s, th float64) input.Frame {
	return input.Frame{SchemaVersion: 1, Source: input.SourceMock, SourceID: "fixture", ReceivedMonoMs: t, Brake: meas(b), Steering: meas(s), Throttle: meas(th)}
}

// trace samples fn every stepMs over [0, durMs].
func trace(durMs float64, fn func(t float64) (b, s, th float64)) []input.Frame {
	var out []input.Frame
	for i := 0; float64(i)*stepMs <= durMs+1e-9; i++ {
		t := float64(i) * stepMs
		b, s, th := fn(t)
		out = append(out, frame(t, b, s, th))
	}
	return out
}

func attempt(o session.Outcome, durMs float64, fs []input.Frame) session.Attempt {
	return session.Attempt{Round: 1, StartMs: 0, EndMs: durMs, Outcome: o, Frames: fs}
}

func val(t *testing.T, d drills.DrillDefinition) *drills.DrillDefinition {
	t.Helper()
	if err := drills.Validate(d, []input.Axis{B, S, T}); err != nil {
		t.Fatal(err)
	}
	d = d.WithDefaults()
	return &d
}

func holdDrill(v, durMs float64) drills.DrillDefinition {
	return drills.DrillDefinition{SchemaVersion: 1, Type: drills.Hold, Timing: drills.Timed, Controls: []input.Axis{B},
		Phases: []drills.Phase{{DurationMs: durMs, Targets: map[input.Axis]drills.Ramp{B: {From: v, To: v}}}}}
}

func sweepDrill(durMs float64) drills.DrillDefinition {
	return drills.DrillDefinition{SchemaVersion: 1, Type: drills.Sweep, Timing: drills.Timed, Controls: []input.Axis{B},
		Phases: []drills.Phase{{DurationMs: durMs, Targets: map[input.Axis]drills.Ramp{B: {From: 0, To: 1}}}}}
}

// trailDrill is the docs/drill-catalog.md example.
func trailDrill() drills.DrillDefinition {
	return drills.DrillDefinition{SchemaVersion: 1, Type: drills.Multistage, Timing: drills.Timed, Controls: []input.Axis{B, S, T},
		Phases: []drills.Phase{
			{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{B: {From: 0.8, To: 0.8}}},
			{DurationMs: 1500, Targets: map[input.Axis]drills.Ramp{B: {From: 0.8, To: 0, Curve: drills.EaseOut, Intensity: 1}, S: {From: 0, To: 0.5}}},
			{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{S: {From: 0.5, To: 0.5}}},
			{DurationMs: 1500, Targets: map[input.Axis]drills.Ramp{S: {From: 0.5, To: 0}, T: {From: 0, To: 1, Curve: drills.EaseIn, Intensity: 1}}},
			{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{T: {From: 1, To: 1}}},
		}}
}

func selfPacedDrill() drills.DrillDefinition {
	return drills.DrillDefinition{SchemaVersion: 1, Type: drills.Progressive, Timing: drills.SelfPaced, Controls: []input.Axis{B},
		Phases: []drills.Phase{{Targets: map[input.Axis]drills.Ramp{B: {From: 0, To: 0.8, Curve: drills.EaseOut, Intensity: 1}}}}}
}

// exact replays a timed drill's desired values, shifted later by lagMs.
func exact(d *drills.DrillDefinition, durMs, lagMs float64) []input.Frame {
	return trace(durMs, func(t float64) (float64, float64, float64) {
		s, err := drills.TargetAt(*d, t-lagMs)
		if err != nil {
			panic(err)
		}
		get := func(a input.Axis) float64 {
			if v, ok := s.Values[a]; ok {
				return v
			}
			return 0
		}
		return get(B), get(S), get(T)
	})
}

// selfPacedRun executes the self-paced shape over shapeMs, then holds the
// terminal value for the completion hold (auto completion).
func selfPacedRun(d *drills.DrillDefinition, shapeMs float64) session.Attempt {
	hold := d.CompletionHoldMsFor()
	fs := trace(shapeMs+hold, func(t float64) (float64, float64, float64) {
		return drills.ShapeAt(*d, t/shapeMs).Values[B], 0, 0
	})
	return attempt(session.OutcomeCompletedAuto, shapeMs+hold, fs)
}

func find(ms []Metric, id string, a input.Axis) Metric {
	for _, m := range ms {
		if m.ID == id && m.Axis == a {
			return m
		}
	}
	panic(fmt.Sprintf("metric %s/%s not found in %v", id, a, ids(ms)))
}

func ids(ms []Metric) []string {
	var out []string
	for _, m := range ms {
		out = append(out, m.ID+"/"+string(m.Axis))
	}
	return out
}

func value(t *testing.T, m Metric) float64 {
	t.Helper()
	if !m.Applicable || m.Value == nil {
		t.Fatalf("%s/%s: want applicable value, got N/A (%s)", m.ID, m.Axis, m.Reason)
	}
	return *m.Value
}

func near(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %v, want %v +/- %v", name, got, want, tol)
	}
}

func notApplicable(t *testing.T, m Metric, reason string) {
	t.Helper()
	if m.Applicable || m.Value != nil || !strings.Contains(m.Reason, reason) {
		t.Errorf("%s/%s: want N/A containing %q, got applicable=%v value=%v reason=%q", m.ID, m.Axis, reason, m.Applicable, m.Value, m.Reason)
	}
}

func one(t *testing.T, d *drills.DrillDefinition, ctl []input.Axis, a ...session.Attempt) SessionResults {
	t.Helper()
	for i := range a {
		a[i].Round = i + 1
	}
	return Analyze(Input{Drill: d, Controls: ctl, Attempts: a, NoiseFloor: 0.005})
}

func TestExactTargetTimedMultistage(t *testing.T) {
	d := val(t, trailDrill())
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 6000, exact(d, 6000, 0))).Rounds[0]
	for _, a := range d.Controls {
		near(t, "mae "+string(a), value(t, find(r.Accuracy, "accuracy.mae", a)), 0, 1e-9)
		near(t, "p95 "+string(a), value(t, find(r.Accuracy, "accuracy.p95", a)), 0, 1e-9)
		near(t, "within "+string(a), value(t, find(r.Accuracy, "accuracy.withinTolerance", a)), 1, 1e-9)
		near(t, "endpoint "+string(a), value(t, find(r.Accuracy, "accuracy.endpoint", a)), 0, 1e-9)
		near(t, "phase "+string(a), value(t, find(r.Accuracy, "accuracy.phaseTransition", a)), 0, 1e-6)
		near(t, "start "+string(a), value(t, find(r.Timing, "timing.startDelay", a)), 0, 0.011)
		near(t, "end "+string(a), value(t, find(r.Timing, "timing.endDelay", a)), 0, 0.011)
		near(t, "transition "+string(a), value(t, find(r.Timing, "timing.phaseTransition", a)), 0, 0.011)
		for _, seg := range []string{"hold", "ramp"} {
			near(t, seg+" jitter "+string(a), value(t, find(r.Smoothness, "smoothness."+seg+".jitter", a)), 0, 0.1)
			near(t, seg+" reversals "+string(a), value(t, find(r.Smoothness, "smoothness."+seg+".reversals", a)), 0, 0)
		}
	}
	if got := r.Phases; len(got) != 5 || got[1].StartMs != 1000 || got[4].StartMs != 5000 {
		t.Errorf("phases = %+v", got)
	}
	if r.Traces[B].Desired == nil || len(r.Traces[B].T) != 601 {
		t.Errorf("timed trace must carry desired at every sample")
	}
}

func TestOffsetHold(t *testing.T) {
	d := val(t, holdDrill(0.4, 2000))
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 2000, trace(2000, func(float64) (float64, float64, float64) { return 0.45, 0, 0 }))).Rounds[0]
	near(t, "mae", value(t, find(r.Accuracy, "accuracy.mae", B)), 5, 1e-9)
	near(t, "p95", value(t, find(r.Accuracy, "accuracy.p95", B)), 5, 1e-9)
	near(t, "bias", value(t, find(r.Accuracy, "accuracy.bias", B)), 5, 1e-9)
	near(t, "endpoint", value(t, find(r.Accuracy, "accuracy.endpoint", B)), 5, 1e-9)
	near(t, "within (beginner tol 0.10)", value(t, find(r.Accuracy, "accuracy.withinTolerance", B)), 1, 0)
	notApplicable(t, find(r.Accuracy, "accuracy.phaseTransition", B), "no internal phase boundary")
	notApplicable(t, find(r.Timing, "timing.startDelay", B), "no desired movement")
	near(t, "hold jitter", value(t, find(r.Smoothness, "smoothness.hold.jitter", B)), 0, 1e-9)
}

func TestWobbleWorseSmoothnessSameBias(t *testing.T) {
	d := val(t, holdDrill(0.4, 2000))
	hold := func(fn func(t float64) float64) RoundResult {
		return one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 2000, trace(2000, func(t float64) (float64, float64, float64) { return fn(t), 0, 0 }))).Rounds[0]
	}
	steady := hold(func(float64) float64 { return 0.4 })
	// 5 Hz, +/-5 pp: above the reversal threshold -> reversals and spikes.
	wobble := hold(func(t float64) float64 { return 0.4 + 0.05*math.Sin(2*math.Pi*t/200) })
	// 12.5 Hz, +/-1.2 pp tremor: below the reversal threshold -> jitter.
	tremor := hold(func(t float64) float64 { return 0.4 + 0.012*math.Sin(2*math.Pi*t/80) })
	for _, r := range []RoundResult{wobble, tremor} {
		near(t, "bias equals steady", value(t, find(r.Accuracy, "accuracy.bias", B)), value(t, find(steady.Accuracy, "accuracy.bias", B)), 0.1)
	}
	if n := value(t, find(wobble.Smoothness, "smoothness.hold.reversals", B)); n < 10 {
		t.Errorf("wobble reversals = %v, want >= 10 (5 Hz for 2 s)", n)
	}
	// A single-frame 10 pp glitch is a spike; smooth motion never is.
	glitch := hold(func(t float64) float64 {
		if t == 1000 {
			return 0.5
		}
		return 0.4
	})
	near(t, "glitch spike", value(t, find(glitch.Smoothness, "smoothness.hold.spike", B)), 9.5, 1e-9)
	if j := value(t, find(tremor.Smoothness, "smoothness.hold.jitter", B)); j < 0.1 {
		t.Errorf("tremor jitter = %v pp, want clearly above steady", j)
	}
	for _, id := range []string{"jitter", "spike", "reversals"} {
		near(t, "steady "+id, value(t, find(steady.Smoothness, "smoothness.hold."+id, B)), 0, 0)
	}
}

func TestIntendedReversalOnlyOnce(t *testing.T) {
	// Steering in the trail drill goes up, holds, comes back: one intended
	// reversal. A wobble on the plateau must still count.
	d := val(t, trailDrill())
	fs := exact(d, 6000, 0)
	for i := range fs {
		if tm := fs[i].ReceivedMonoMs; tm >= 2600 && tm < 3400 {
			v := 0.5 + 0.05*math.Sin(2*math.Pi*tm/200)
			fs[i].Steering = meas(v)
		}
	}
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 6000, fs)).Rounds[0]
	if n := value(t, find(r.Smoothness, "smoothness.hold.reversals", S)); n < 5 {
		t.Errorf("plateau wobble reversals = %v, want counted", n)
	}
}

func TestSmoothFastMotionIsNotJitter(t *testing.T) {
	// Timed fast sweep (0 -> 100% in 300 ms) executed exactly.
	d := val(t, sweepDrill(300))
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 300, exact(d, 300, 0))).Rounds[0]
	near(t, "fast ramp jitter", value(t, find(r.Smoothness, "smoothness.ramp.jitter", B)), 0, 0.1)
	near(t, "fast ramp reversals", value(t, find(r.Smoothness, "smoothness.ramp.reversals", B)), 0, 0)
	// Freeform: deliberate 100 ms full application then hold (a corner).
	f := one(t, nil, []input.Axis{B}, attempt(session.OutcomeCompletedTimed, 1500, trace(1500, func(t float64) (float64, float64, float64) {
		return math.Min(t/100, 1), 0, 0
	}))).Rounds[0]
	near(t, "freeform fast jitter", value(t, find(f.Smoothness, "smoothness.all.jitter", B)), 0, 0.1)
	near(t, "freeform fast spike", value(t, find(f.Smoothness, "smoothness.all.spike", B)), 0, 0)
	near(t, "freeform fast reversals", value(t, find(f.Smoothness, "smoothness.all.reversals", B)), 0, 0)
}

func TestLateExecutionTiming(t *testing.T) {
	d := val(t, sweepDrill(1000))
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 1500, exact(d, 1500, 200))).Rounds[0]
	near(t, "start delay", value(t, find(r.Timing, "timing.startDelay", B)), 0.2, 0.011)
	near(t, "end delay", value(t, find(r.Timing, "timing.endDelay", B)), 0.2, 0.011)
	near(t, "transition", value(t, find(r.Timing, "timing.phaseTransition", B)), 0.2, 0.011)
}

func TestDroppedFramesCoverageNA(t *testing.T) {
	d := val(t, holdDrill(0.4, 2000))
	var fs []input.Frame
	for i, f := range trace(2000, func(float64) (float64, float64, float64) { return 0.4, 0, 0 }) {
		if k := i % 10; k == 0 || k > 6 { // keep 40% in bursts: 70 ms holes
			fs = append(fs, f)
		}
	}
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 2000, fs)).Rounds[0]
	for _, m := range slices.Concat(r.Accuracy, r.Smoothness, r.Timing) {
		notApplicable(t, m, "coverage")
		if m.Coverage == nil || *m.Coverage > 0.5 {
			t.Errorf("%s coverage = %v", m.ID, m.Coverage)
		}
	}
}

func TestLowSampleRateSmoothnessNA(t *testing.T) {
	d := val(t, holdDrill(0.4, 2000))
	var fs []input.Frame
	for tm := 0.0; tm <= 2000; tm += 60 {
		fs = append(fs, frame(tm, 0.4, 0, 0))
	}
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 2000, fs)).Rounds[0]
	notApplicable(t, find(r.Smoothness, "smoothness.hold.jitter", B), "sample interval")
	value(t, find(r.Accuracy, "accuracy.mae", B)) // accuracy still applicable
}

func TestSelfPacedSlowAndFastSameAccuracy(t *testing.T) {
	d := val(t, selfPacedDrill())
	res := one(t, d, d.Controls, selfPacedRun(d, 2000), selfPacedRun(d, 6000))
	fast, slow := res.Rounds[0], res.Rounds[1]
	for _, r := range []RoundResult{fast, slow} {
		near(t, "shape mae", value(t, find(r.Accuracy, "accuracy.shapeMae", B)), 0, 1e-9)
		near(t, "shape p95", value(t, find(r.Accuracy, "accuracy.shapeP95", B)), 0, 1e-9)
		near(t, "endpoint", value(t, find(r.Accuracy, "accuracy.endpoint", B)), 0, 1e-9)
		notApplicable(t, find(r.Timing, "timing", ""), "self-paced")
		if !r.SelfPaced || r.Traces[B].Desired != nil || r.Shape[B] == nil || len(r.Phases) != 0 {
			t.Errorf("self-paced round must have no time-aligned desired, a shape trace and no time phases")
		}
	}
	if fast.DurationMs >= slow.DurationMs {
		t.Errorf("durations reported descriptively: %v vs %v", fast.DurationMs, slow.DurationMs)
	}
	for _, m := range res.Consistency {
		if strings.HasPrefix(m.ID, "consistency.timing") {
			t.Errorf("duration must not become a timing consistency metric: %s", m.ID)
		}
	}
}

func TestSelfPacedNoTautologicalAlignment(t *testing.T) {
	// The user never moves: shape accuracy must be poor, not "perfect".
	d := val(t, selfPacedDrill())
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedManual, 3000, trace(3000, func(float64) (float64, float64, float64) { return 0, 0, 0 })))
	if mae := value(t, find(r.Rounds[0].Accuracy, "accuracy.shapeMae", B)); mae < 30 {
		t.Errorf("idle self-paced shape MAE = %v pp, want large", mae)
	}
	near(t, "endpoint", value(t, find(r.Rounds[0].Accuracy, "accuracy.endpoint", B)), 80, 0.5)
}

func TestSelfPacedMultistageCoordinationNA(t *testing.T) {
	d := trailDrill()
	d.Timing = drills.SelfPaced
	dd := val(t, d)
	r := one(t, dd, dd.Controls, attempt(session.OutcomeCompletedManual, 6000, exact(val(t, trailDrill()), 6000, 0))).Rounds[0]
	// Phase durations weight the normalized shape, so an exact 6 s run matches.
	near(t, "shape mae", value(t, find(r.Accuracy, "accuracy.shapeMae", S)), 0, 1e-9)
	value(t, find(r.Accuracy, "accuracy.phaseTransition", S))
	notApplicable(t, find(r.Accuracy, "accuracy.coordination", ""), "progress parameter")
}

func TestFreeform(t *testing.T) {
	res := one(t, nil, []input.Axis{B, S}, attempt(session.OutcomeCompletedTimed, 1000, trace(1000, func(float64) (float64, float64, float64) { return 0.3, 0.1, na })))
	r := res.Rounds[0]
	if len(r.Accuracy) != 1 || len(r.Timing) != 1 {
		t.Fatalf("freeform: want one N/A accuracy and timing metric, got %v %v", ids(r.Accuracy), ids(r.Timing))
	}
	notApplicable(t, r.Accuracy[0], "freeform")
	notApplicable(t, r.Timing[0], "freeform")
	value(t, find(r.Smoothness, "smoothness.all.jitter", S))
	if res.Mode != "freeform" || res.Drill != nil || len(res.Recommendations) != 0 || r.Traces[B].Desired != nil {
		t.Errorf("freeform results: %+v", res)
	}
	notApplicable(t, find(res.Consistency, "consistency", ""), "2 valid rounds")
}

func TestInvalidAndSkippedNeverScored(t *testing.T) {
	d := val(t, holdDrill(0.4, 2000))
	good := trace(2000, func(float64) (float64, float64, float64) { return 0.4, 0, 0 })
	res := one(t, d, d.Controls,
		attempt(session.OutcomeCompletedTimed, 2000, good),
		attempt(session.OutcomeInvalidSourceLost, 800, good[:80]),
		attempt(session.OutcomeSkipped, 0, nil))
	for _, r := range res.Rounds[1:] {
		for _, m := range slices.Concat(r.Accuracy, r.Smoothness, r.Timing) {
			notApplicable(t, m, "not scored")
		}
	}
	notApplicable(t, find(res.Consistency, "consistency", ""), "2 valid rounds")
	if len(res.Recommendations) == 0 || !strings.Contains(res.Recommendations[len(res.Recommendations)-1].Text, "source") {
		t.Errorf("want a source-loss note, got %+v", res.Recommendations)
	}
}

func TestConsistency(t *testing.T) {
	d := val(t, holdDrill(0.4, 2000))
	var as []session.Attempt
	for _, off := range []float64{0.02, 0.04, 0.06} {
		as = append(as, attempt(session.OutcomeCompletedTimed, 2000, trace(2000, func(float64) (float64, float64, float64) { return 0.4 + off, 0, 0 })))
	}
	res := one(t, d, d.Controls, as...)
	near(t, "std mae", value(t, find(res.Consistency, "consistency.accuracy.mae", B)), 2, 1e-9)
	near(t, "trajectory", value(t, find(res.Consistency, "consistency.trajectory", B)), 2, 1e-9)
}

func TestRecommendationsSuggestOnly(t *testing.T) {
	d := val(t, holdDrill(0.4, 2000))
	before, _ := json.Marshal(d)
	f := trace(2000, func(float64) (float64, float64, float64) { return 0.4, 0, 0 })
	res := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 2000, f), attempt(session.OutcomeCompletedTimed, 2000, f))
	if after, _ := json.Marshal(d); string(after) != string(before) {
		t.Fatal("Analyze must never change the drill")
	}
	if len(res.Recommendations) != 1 {
		t.Fatalf("recommendations = %+v", res.Recommendations)
	}
	c := res.Recommendations[0].Change
	if c == nil || c.Path != "difficulty" || c.From != drills.Beginner || c.To != drills.Intermediate {
		t.Errorf("change = %+v", c)
	}
	// Poor accuracy at intermediate suggests the easier preset.
	d.Difficulty = drills.Intermediate
	off := trace(2000, func(float64) (float64, float64, float64) { return 0.6, 0, 0 })
	res = one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 2000, off), attempt(session.OutcomeCompletedTimed, 2000, off))
	if c := res.Recommendations[0].Change; c == nil || c.To != drills.Beginner {
		t.Errorf("easier change = %+v", res.Recommendations)
	}
}

func TestDisplayDownsamplePreservesExtremesAndGaps(t *testing.T) {
	var fs []input.Frame
	for i := range 5000 {
		v := 0.5 + 0.4*math.Sin(float64(i)/37)
		if i == 2345 {
			v = 1 // single-sample spike must survive
		}
		if i >= 3000 && i < 3010 {
			v = na
		}
		fs = append(fs, frame(float64(i)*stepMs, v, 0, 0))
	}
	r := one(t, nil, []input.Axis{B}, attempt(session.OutcomeCompletedTimed, 49990, fs)).Rounds[0]
	full, disp := r.Traces[B], r.Display[B]
	if len(full.T) != 5000 || len(disp.T) > MaxDisplayPoints || len(disp.T) < 500 {
		t.Fatalf("full %d, display %d", len(full.T), len(disp.T))
	}
	if !slices.Contains(disp.Actual, 1) || !slices.ContainsFunc(disp.Actual, math.IsNaN) {
		t.Error("display lost the spike or the gap")
	}
	if disp.T[0] != 0 || disp.T[len(disp.T)-1] != full.T[4999] || len(disp.Valid) != len(disp.T) || len(disp.Filtered) != len(disp.T) {
		t.Error("display must keep both ends and align every series")
	}
	b, _ := json.Marshal(disp)
	if !strings.Contains(string(b), "null") {
		t.Error("gap must marshal as null, never 0")
	}
}

func TestNoCompositeScore(t *testing.T) {
	d := val(t, trailDrill())
	b, _ := json.Marshal(one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 6000, exact(d, 6000, 0))))
	for _, bad := range []string{"score", "overall", "composite", "grade", "total"} {
		if strings.Contains(strings.ToLower(string(b)), bad) {
			t.Errorf("results mention %q", bad)
		}
	}
}

// TestFixtures pins every metric of every fixture to versioned expected
// values (spec 11.1). Run with -update after an intended formula change
// and bump the formula version.
func TestFixtures(t *testing.T) {
	trail, hold, sweep, sp := val(t, trailDrill()), val(t, holdDrill(0.4, 2000)), val(t, sweepDrill(300)), val(t, selfPacedDrill())
	steady := func(v float64) []input.Frame {
		return trace(2000, func(float64) (float64, float64, float64) { return v, 0, 0 })
	}
	fixtures := map[string]SessionResults{
		"exactTrail":     one(t, trail, trail.Controls, attempt(session.OutcomeCompletedTimed, 6000, exact(trail, 6000, 0))),
		"lateTrail":      one(t, trail, trail.Controls, attempt(session.OutcomeCompletedTimed, 6000, exact(trail, 6000, 150))),
		"offsetHold":     one(t, hold, hold.Controls, attempt(session.OutcomeCompletedTimed, 2000, steady(0.45))),
		"wobbleHold":     one(t, hold, hold.Controls, attempt(session.OutcomeCompletedTimed, 2000, trace(2000, func(t float64) (float64, float64, float64) { return 0.4 + 0.05*math.Sin(2*math.Pi*t/200), 0, 0 }))),
		"fastSweep":      one(t, sweep, sweep.Controls, attempt(session.OutcomeCompletedTimed, 300, exact(sweep, 300, 0))),
		"selfPaced":      one(t, sp, sp.Controls, selfPacedRun(sp, 2000), selfPacedRun(sp, 6000)),
		"inconsistent":   one(t, hold, hold.Controls, attempt(session.OutcomeCompletedTimed, 2000, steady(0.42)), attempt(session.OutcomeCompletedTimed, 2000, steady(0.46))),
		"fastReversal":   one(t, nil, []input.Axis{B}, attempt(session.OutcomeCompletedTimed, 400, trace(400, func(t float64) (float64, float64, float64) { return math.Max(0, 1-math.Abs(t-150)/50), 0, 0 }))),
		"glitchHold":     one(t, hold, hold.Controls, attempt(session.OutcomeCompletedTimed, 2000, trace(2000, func(t float64) (float64, float64, float64) { return 0.4 + 0.1*b2f(t == 1000), 0, 0 }))),
		"burstySampling": one(t, hold, hold.Controls, attempt(session.OutcomeCompletedTimed, 2000, bursty())),
		"freeformSteer":  one(t, nil, []input.Axis{S}, attempt(session.OutcomeCompletedTimed, 1000, trace(1000, func(t float64) (float64, float64, float64) { return na, math.Sin(t / 300), na }))),
	}
	got := map[string]map[string]any{}
	for name, res := range fixtures {
		m := map[string]any{}
		add := func(prefix string, ms []Metric) {
			for _, x := range ms {
				k := prefix + x.ID + "/" + string(x.Axis) + "@" + x.FormulaVersion
				if x.Value == nil {
					m[k] = "N/A: " + x.Reason
				} else {
					m[k] = math.Round(*x.Value*1e6) / 1e6
				}
			}
		}
		for _, r := range res.Rounds {
			p := fmt.Sprintf("r%d.", r.Round)
			add(p, r.Accuracy)
			add(p, r.Smoothness)
			add(p, r.Timing)
		}
		add("", res.Consistency)
		got[name] = m
	}
	const path = "testdata/fixtures_v1.json"
	if *update {
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(path, append(b, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test ./metrics -run TestFixtures -update)", err)
	}
	var want map[string]map[string]any
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	gb, _ := json.Marshal(got)
	var gotNorm map[string]map[string]any
	_ = json.Unmarshal(gb, &gotNorm)
	for name := range gotNorm {
		for k, v := range gotNorm[name] {
			if w := want[name][k]; fmt.Sprint(w) != fmt.Sprint(v) {
				t.Errorf("%s %s = %v, fixture %v", name, k, v, w)
			}
		}
		if len(want[name]) != len(gotNorm[name]) {
			t.Errorf("%s: %d metrics, fixture has %d", name, len(gotNorm[name]), len(want[name]))
		}
	}
}

// Review findings (Phase 4 Codex review).

func TestFastIntentionalReversalIsNotASpike(t *testing.T) {
	// Exact 0 -> 1 -> 0 in 100 ms (sampled every 10 ms): fast but intended.
	tri := func(t float64) float64 { return math.Max(0, 1-math.Abs(t-150)/50) }
	f := one(t, nil, []input.Axis{B}, attempt(session.OutcomeCompletedTimed, 400, trace(400, func(t float64) (float64, float64, float64) { return tri(t), 0, 0 }))).Rounds[0]
	near(t, "freeform fast reversal spike", value(t, find(f.Smoothness, "smoothness.all.spike", B)), 0, 0)
	// A two-sample glitch that returns to the prior level is still a spike.
	g := one(t, nil, []input.Axis{B}, attempt(session.OutcomeCompletedTimed, 400, trace(400, func(t float64) (float64, float64, float64) {
		if t == 200 || t == 210 {
			return 0.5, 0, 0
		}
		return 0.4, 0, 0
	}))).Rounds[0]
	near(t, "double glitch spike", value(t, find(g.Smoothness, "smoothness.all.spike", B)), 9.5, 1e-9)
}

func TestDownsampleKeepsEveryGapBreak(t *testing.T) {
	n := 5000
	tr := Trace{T: make([]float64, n), Actual: make(Series, n), Valid: make([]bool, n)}
	for i := range n {
		tr.T[i], tr.Actual[i], tr.Valid[i] = float64(i), 0.5, true
	}
	// Two separate gaps inside one bucket, with the bucket max between them.
	lo := 201 * n / ((MaxDisplayPoints - 2) / 3)
	gaps := []float64{float64(lo + 2), float64(lo + 10)}
	for _, g := range gaps {
		tr.Actual[int(g)], tr.Valid[int(g)] = math.NaN(), false
	}
	tr.Actual[lo+6] = 0.9
	d := downsample(tr, MaxDisplayPoints)
	if len(d.T) > MaxDisplayPoints {
		t.Fatalf("display %d points", len(d.T))
	}
	// Every pair of consecutive kept valid points must not span a gap.
	for j := 1; j < len(d.T); j++ {
		if math.IsNaN(d.Actual[j]) || math.IsNaN(d.Actual[j-1]) {
			continue
		}
		for _, g := range gaps {
			if d.T[j-1] < g && g < d.T[j] {
				t.Errorf("display bridges the gap at %v between %v and %v", g, d.T[j-1], d.T[j])
			}
		}
	}
}

func TestBurstySamplingIsNotFullCoverage(t *testing.T) {
	// Hidden-tab style bursts: frames at 0,1,100,101,...: 99 ms blind spots.
	d := val(t, holdDrill(0.4, 2000))
	var fs []input.Frame
	for tm := 0.0; tm <= 2000; tm += 100 {
		fs = append(fs, frame(tm, 0.4, 0, 0))
		if tm+1 <= 2000 {
			fs = append(fs, frame(tm+1, 0.4, 0, 0))
		}
	}
	r := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 2000, fs)).Rounds[0]
	notApplicable(t, find(r.Smoothness, "smoothness.hold.jitter", B), "")
	if m := find(r.Accuracy, "accuracy.mae", B); m.Coverage == nil || *m.Coverage >= MinCoverage {
		t.Errorf("bursty coverage = %v, want < %v", m.Coverage, MinCoverage)
	}
}

func TestRecommendationsNeedEligibleRoundsPerAxis(t *testing.T) {
	d := val(t, holdDrill(0.4, 2000))
	good := trace(2000, func(float64) (float64, float64, float64) { return 0.4, 0, 0 })
	var sparse []input.Frame // completed but 40% coverage: metrics N/A
	for i, f := range good {
		if k := i % 10; k == 0 || k > 6 {
			sparse = append(sparse, f)
		}
	}
	res := one(t, d, d.Controls, attempt(session.OutcomeCompletedTimed, 2000, good), attempt(session.OutcomeCompletedTimed, 2000, sparse))
	if len(res.Recommendations) != 0 {
		t.Errorf("one scorable round must not drive a recommendation: %+v", res.Recommendations)
	}
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// bursty: frames at 0,1,100,101,... ms with brake held at 0.4.
func bursty() []input.Frame {
	var fs []input.Frame
	for tm := 0.0; tm <= 2000; tm += 100 {
		fs = append(fs, frame(tm, 0.4, 0, 0))
		if tm+1 <= 2000 {
			fs = append(fs, frame(tm+1, 0.4, 0, 0))
		}
	}
	return fs
}
