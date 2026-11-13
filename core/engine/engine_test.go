package engine

import (
	"reflect"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/drills"
	"github.com/arush-sal/trail-braking-trainer/core/input"
)

func trailBrake() drills.DrillDefinition {
	hold := func(v float64) drills.Ramp { return drills.Ramp{From: v, To: v} }
	return drills.DrillDefinition{
		SchemaVersion: drills.SchemaVersion, Type: drills.Multistage, Timing: drills.Timed, Controls: []input.Axis{B, S, T},
		Phases: []drills.Phase{
			{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{B: hold(0.8)}},
			{DurationMs: 1500, Targets: map[input.Axis]drills.Ramp{B: {From: 0.8, To: 0, Curve: drills.EaseOut, Intensity: 1}, S: {From: 0, To: 0.5}}},
			{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{S: hold(0.5)}},
			{DurationMs: 1500, Targets: map[input.Axis]drills.Ramp{S: {From: 0.5, To: 0}, T: {From: 0, To: 1, Curve: drills.EaseIn, Intensity: 1}}},
			{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{T: hold(1)}},
		},
	}
}

// overlapOnsets runs fs through a fresh detector and returns onset times.
func overlapOnsets(t *testing.T, cfg OverlapConfig, fs []input.Frame) []float64 {
	t.Helper()
	d := NewOverlapDetector(cfg)
	onsets := []float64{}
	for _, f := range fs {
		before := f
		if ev, ok := d.Observe(f); ok {
			onsets = append(onsets, ev.AtMs)
		}
		if !reflect.DeepEqual(before, f) {
			t.Fatal("detector modified the input frame")
		}
	}
	return onsets
}

func TestOverlapDetector(t *testing.T) {
	def := DefaultOverlapConfig() // enter 0.05, exit 0.02, cooldown 500ms
	noisy := def
	noisy.NoiseFloor = 0.03
	ramp := func(t float64) float64 { return 0.3 * (t - 1000) / 1000 }
	tests := []struct {
		name string
		cfg  OverlapConfig
		fs   []input.Frame
		want []float64 // expected onset event times (ms)
	}{
		{"exact trail-brake target never overlaps", def, exactTarget(trailBrake(), 500), []float64{}},
		{"clean overlap: one onset at entry", def, overlapTrace(3000, 1000, 2000, ramp), []float64{1190}},
		{"flapping above exit threshold: one alert", def, overlapTrace(3000, 1000, 2000, flap(0.04, 0.06)), []float64{1000}},
		{"flapping across exit within cooldown: one alert", def, overlapTrace(3000, 1000, 2000, flap(0, 0.06)), []float64{1000}},
		{"two overlaps separated by more than cooldown", def, overlapTrace(3000, 1000, 2300, pause(1200, 2000)), []float64{1000, 2000}},
		{"re-entry inside cooldown: no second alert", def, overlapTrace(3000, 1000, 1700, pause(1200, 1500)), []float64{1000}},
		{"sensor noise near zero throttle: no alert", def, withNoise(constant(3000, 0.5, 0, 0), 0.01, 7), []float64{}},
		{"noise floor raises activation threshold", noisy, overlapTrace(3000, 1000, 2000, flap(0.06, 0.06)), []float64{}},
		{"throttle unavailable never counts", def, constant(2000, 0.5, 0, na), []float64{}},
		{"steering missing does not matter", def, steeringMissing(overlapTrace(3000, 1000, 2000, flap(0.1, 0.1))), []float64{1000}},
		{"gap frame mid-overlap does not re-alert", def, markGap(overlapTrace(3000, 1000, 2000, flap(0.1, 0.1)), 1500), []float64{1000}},
		{"out-of-order frames: stale frame ignored", def, outOfOrder(overlapTrace(3000, 1000, 2000, flap(0.1, 0.1))), []float64{1010}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := overlapOnsets(t, tc.cfg, tc.fs); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("onsets %v, want %v", got, tc.want)
			}
		})
	}
}

// pause is throttle 0.1 except released in [fromMs,toMs).
func pause(fromMs, toMs float64) func(float64) float64 {
	return func(t float64) float64 {
		if t >= fromMs && t < toMs {
			return 0
		}
		return 0.1
	}
}

func TestOverlapEventCarriesUnsuppressedValues(t *testing.T) {
	d := NewOverlapDetector(DefaultOverlapConfig())
	ev, ok := d.Observe(frame(42, 0.7, 0, 0.9))
	if !ok || ev != (OverlapEvent{AtMs: 42, Brake: 0.7, Throttle: 0.9}) || !d.Active() {
		t.Fatalf("event %+v ok=%v active=%v", ev, ok, d.Active())
	}
}

func selfPacedHold(a input.Axis, v float64) drills.DrillDefinition {
	return drills.DrillDefinition{
		SchemaVersion: drills.SchemaVersion, Type: drills.Hold, Timing: drills.SelfPaced, Controls: []input.Axis{a},
		Phases: []drills.Phase{{Targets: map[input.Axis]drills.Ramp{a: {From: v, To: v}}}},
	}
}

// completeAt returns the first frame time at which the detector reports
// completion, or -1.
func completeAt(d drills.DrillDefinition, fs []input.Frame) float64 {
	c := NewCompletionDetector(d, DefaultCompletionConfig())
	for _, f := range fs {
		if c.Observe(f) {
			return f.ReceivedMonoMs
		}
	}
	return -1
}

func TestCompletionDetector(t *testing.T) {
	// Beginner preset: tolerance 0.10, hold 500ms; exit band 0.125.
	brake := selfPacedHold(B, 0.4)
	tb := trailBrake()
	tb.Timing = drills.SelfPaced
	tests := []struct {
		name string
		def  drills.DrillDefinition
		fs   []input.Frame
		want float64 // first completion time, -1 = never
	}{
		{"exact hold", brake, offsetHold(2000, 0.4, 0), 500},
		{"offset within tolerance", brake, offsetHold(2000, 0.4, 0.07), 500},
		{"offset beyond tolerance", brake, offsetHold(2000, 0.4, 0.15), -1},
		{"wobble inside hysteresis band", brake, wobbleHold(2000, 0.4, 0.12, 200), 500},
		{"wobble beyond band", brake, wobbleHold(3000, 0.4, 0.3, 400), -1},
		{"sensor noise", brake, withNoise(offsetHold(2000, 0.4, 0), 0.03, 1), 500},
		{"false terminal fly-through", brake, smoothMove(2000, 0, 1, 1000), -1},
		{"jerky reversal: early pass and snap-back never count", brake, jerkyReversal(), 930},
		{"slow smooth approach", brake, smoothMove(4000, 0, 0.4, 2000), 2000},
		{"deliberate fast approach", brake, smoothMove(2000, 0, 0.4, 50), 540},
		{"dropped frames reset the hold", brake, dropFrames(offsetHold(2000, 0.4, 0), 200, 400), 900},
		{"gap frame resets the hold", brake, markGap(offsetHold(2000, 0.4, 0), 300), 810},
		{"out-of-order frames never count", brake, outOfOrder(offsetHold(2000, 0.4, 0)), 510},
		{"steering terminal missing never completes", selfPacedHold(S, 0.2), steeringMissing(constant(2000, 0, 0.2, 0)), -1},
		{"multistage completes on terminal throttle", tb, exactTarget(trailBrake(), 1000), 5430},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := completeAt(tc.def, tc.fs); got != tc.want {
				t.Fatalf("completed at %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCompletionLatchesAndResets(t *testing.T) {
	c := NewCompletionDetector(selfPacedHold(B, 0.4), DefaultCompletionConfig())
	for _, f := range offsetHold(600, 0.4, 0) {
		c.Observe(f)
	}
	if !c.Observe(frame(610, 0.9, 0, 0)) {
		t.Fatal("completion must latch once reached")
	}
	c.Reset()
	if c.Observe(frame(620, 0.4, 0, 0)) {
		t.Fatal("Reset must clear completion and the hold")
	}
}

func TestGuidedPrimary(t *testing.T) {
	coastFirst := trailBrake()
	coastFirst.Phases = []drills.Phase{{DurationMs: 500}, {DurationMs: 500, Targets: map[input.Axis]drills.Ramp{B: {From: 0, To: 0.5}}}}
	centre := selfPacedHold(S, 0)
	directHandoff := trailBrake()
	directHandoff.Phases = []drills.Phase{
		{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{B: {From: 0.6, To: 0}, S: {From: 0, To: 0.4}}},
		{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{S: {From: 0.4, To: 0}, T: {From: 0, To: 0.7}}},
		{DurationMs: 1000},
	}
	reBrake := trailBrake()
	reBrake.Phases = []drills.Phase{
		{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{B: {From: 0.6, To: 0.3}, S: {From: 0, To: 0.4}}},
		{DurationMs: 1000, Targets: map[input.Axis]drills.Ramp{B: {From: 0.3, To: 0.3}, S: {From: 0.4, To: 0}}},
	}
	tests := []struct {
		name string
		def  drills.DrillDefinition
		want []input.Axis // per phase
	}{
		{"B -> B+S -> S -> S+T -> T", trailBrake(), []input.Axis{B, S, S, T, T}},
		{"coast before brake focuses next control", coastFirst, []input.Axis{B, B}},
		{"steering centre hold", centre, []input.Axis{S}},
		{"B+S straight to S+T, then coast keeps T", directHandoff, []input.Axis{S, T, T}},
		{"brake re-applied after B+S keeps S", reBrake, []input.Axis{S, S}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var got []input.Axis
			for i := range tc.def.Phases {
				got = append(got, GuidedPrimary(tc.def, i))
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

type change struct {
	AtMs float64
	To   input.Axis
}

func primaryChanges(controls []input.Axis, fs []input.Frame) []change {
	p := NewFreeformPrimary(controls, DefaultPrimaryConfig())
	out := []change{}
	for _, f := range fs {
		if a, changed := p.Observe(f); changed {
			out = append(out, change{f.ReceivedMonoMs, a})
		}
	}
	return out
}

func TestFreeformPrimary(t *testing.T) {
	all := []input.Axis{B, S, T}
	// A freeform trail-brake: B on at 0, S on at 500, B off at 800,
	// T on at 1200, S off at 1500, everything off at 2000.
	freeTrail := trace(3000, func(t float64) (float64, float64, float64) {
		on := func(from, to float64, v float64) float64 {
			if t >= from && t < to {
				return v
			}
			return 0
		}
		return on(0, 800, 0.6), on(500, 1500, -0.4), on(1200, 2000, 0.5)
	})
	tests := []struct {
		name     string
		controls []input.Axis
		fs       []input.Frame
		want     []change
	}{
		{"follows newly engaged control, holds after release", all, freeTrail, []change{{0, B}, {500, S}, {1200, T}}},
		{"hover below enter threshold never switches", all,
			trace(2000, func(t float64) (float64, float64, float64) { return 0.5, flap(0.02, 0.07)(t), 0 }), []change{{0, B}}},
		{"chatter above exit threshold switches once", all,
			trace(2000, func(t float64) (float64, float64, float64) {
				if t < 1000 {
					return 0.5, 0, 0
				}
				return 0.5, flap(0.05, 0.1)(t), 0
			}), []change{{0, B}, {1000, S}}},
		{"minimum dwell delays a rapid second handoff", all,
			trace(2000, func(t float64) (float64, float64, float64) {
				b, s, th := 0.5, 0.0, 0.0
				if t >= 1000 {
					b, s = 0, 0.3
				}
				if t >= 1100 {
					th = 0.4
				}
				return b, s, th
			}), []change{{0, B}, {1000, S}, {1250, T}}},
		{"primary released while other held falls back", all,
			trace(2000, func(t float64) (float64, float64, float64) {
				s := 0.0
				if t >= 500 && t < 1000 {
					s = 0.3
				}
				return 0.5, s, 0
			}), []change{{0, B}, {500, S}, {1000, B}}},
		{"unavailable steering is never primary", all, steeringMissing(freeTrail), []change{{0, B}, {1200, T}}},
		{"unselected control ignored", []input.Axis{B}, freeTrail, []change{{0, B}}},
		{"out-of-order frames do not cause switches", all, outOfOrder(freeTrail), []change{{10, B}, {510, S}, {1210, T}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := primaryChanges(tc.controls, tc.fs); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
