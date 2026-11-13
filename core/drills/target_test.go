package drills

import (
	"math"
	"math/rand/v2"
	"reflect"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/input"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestTargetAt(t *testing.T) {
	tb := trailBrake()
	tests := []struct {
		name      string
		def       DrillDefinition
		tMs       float64
		phase     int
		want      map[input.Axis]float64
		done      bool
		terminals []input.Axis
	}{
		{"hold start", holdDrill(0.4), 0, 0, map[input.Axis]float64{B: 0.4}, false, []input.Axis{B}},
		{"hold end", holdDrill(0.4), 3000, 0, map[input.Axis]float64{B: 0.4}, true, []input.Axis{B}},
		{"before start clamps", holdDrill(0.4), -50, 0, map[input.Axis]float64{B: 0.4}, false, []input.Axis{B}},
		{"sweep quarter", sweepDrill(), 250, 0, map[input.Axis]float64{T: 0.25}, false, []input.Axis{T}},
		{"multistage first hold", tb, 500, 0, map[input.Axis]float64{B: 0.8, S: 0, T: 0}, false, []input.Axis{T}},
		{"boundary belongs to next phase", tb, 1000, 1, map[input.Axis]float64{B: 0.8, S: 0, T: 0}, false, []input.Axis{T}},
		// phase 1 midpoint: B easeOut(1) 0.8->0 = 0.8-0.8*0.75 = 0.2; S linear 0->0.5 = 0.25
		{"B+S ramp midpoint", tb, 1750, 1, map[input.Axis]float64{B: 0.2, S: 0.25, T: 0}, false, []input.Axis{T}},
		{"steering only", tb, 3000, 2, map[input.Axis]float64{B: 0, S: 0.5, T: 0}, false, []input.Axis{T}},
		// phase 3 midpoint: T easeIn(1) = 0.25
		{"S+T ramp midpoint", tb, 4250, 3, map[input.Axis]float64{B: 0, S: 0.25, T: 0.25}, false, []input.Axis{T}},
		{"after end holds terminal", tb, 99999, 4, map[input.Axis]float64{B: 0, S: 0, T: 1}, true, []input.Axis{T}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, err := TargetAt(tc.def, tc.tMs)
			if err != nil {
				t.Fatal(err)
			}
			if s.Phase != tc.phase || s.Done != tc.done || len(s.Values) != len(tc.want) || !reflect.DeepEqual(s.Terminal, tc.terminals) {
				t.Fatalf("got %+v", s)
			}
			for a, v := range tc.want {
				if got, ok := s.Values[a]; !ok || !near(got, v) {
					t.Errorf("%s = %v (present=%v), want %v", a, got, ok, v)
				}
			}
		})
	}
	if _, err := TargetAt(progressiveDrill(), 10); err == nil {
		t.Fatal("TargetAt must refuse self-paced drills (no instantaneous target, spec 3.4)")
	}
}

func TestShapeAt(t *testing.T) {
	sp := trailBrake()
	sp.Timing = SelfPaced
	for i := range sp.Phases {
		sp.Phases[i].DurationMs = 0 // equal weights: each phase is 1/5 of progress
	}
	s := ShapeAt(sp, 0.3) // phase 1, local 0.5
	if s.Phase != 1 || !near(s.Values[B], 0.2) || !near(s.Values[S], 0.25) {
		t.Fatalf("equal-weight shape: %+v", s)
	}
	if s := ShapeAt(sp, 1); s.Phase != 4 || !s.Done || s.Values[T] != 1 {
		t.Fatalf("u=1: %+v", s)
	}
	// With durations the weights follow them, and ShapeAt agrees with TargetAt.
	tb := trailBrake()
	for _, tMs := range []float64{0, 700, 1000, 2600, 4999, 6000} {
		want, _ := TargetAt(tb, tMs)
		if got := ShapeAt(tb, tMs/6000); !reflect.DeepEqual(got, want) {
			t.Errorf("t=%v: ShapeAt %+v != TargetAt %+v", tMs, got, want)
		}
	}
	if s := ShapeAt(progressiveDrill(), 0.5); !near(s.Values[B], 0.9-0.9*0.75) {
		t.Fatalf("progressive easeOut midpoint: %+v", s)
	}
}

// randomDrill builds a phase chain that is continuous by construction, so a
// useful fraction passes Validate; the rest probes the rejection paths.
func randomDrill(r *rand.Rand) DrillDefinition {
	sels := [][]input.Axis{{B}, {S}, {T}, {B, S}, {S, T}, {B, S, T}}
	d := DrillDefinition{SchemaVersion: SchemaVersion, Type: Multistage, Timing: Timed, Controls: sels[r.IntN(len(sels))]}
	cur := map[input.Axis]float64{}
	curves := []Curve{Linear, EaseIn, EaseOut, EaseInOut}
	for range 2 + r.IntN(5) {
		p := Phase{DurationMs: float64(1 + r.IntN(2000)), Targets: map[input.Axis]Ramp{}}
		switch r.IntN(20) { // occasionally extreme durations
		case 0:
			p.DurationMs = 1e308
		case 1:
			p.DurationMs = MaxDurationMs
		case 2:
			p.DurationMs = 1e-300
		}
		for _, a := range d.Controls {
			to := 0.0
			if r.IntN(2) == 0 {
				to = r.Float64()
				if a == S {
					to = 2*to - 1
				}
			}
			if cur[a] != 0 || to != 0 || r.IntN(4) == 0 {
				p.Targets[a] = Ramp{From: cur[a], To: to, Curve: curves[r.IntN(4)], Intensity: r.Float64() * MaxIntensity}
			}
			cur[a] = to
		}
		d.Phases = append(d.Phases, p)
	}
	return d
}

// The hard invariant (spec 3.2), checked by dense sampling rather than by
// trusting Validate's analytic per-segment rule: no accepted drill ever
// schedules brake and throttle both above target-zero at the same instant.
func checkNoOverlap(t *testing.T, d DrillDefinition) {
	t.Helper()
	if Validate(d, allAxes) != nil {
		return
	}
	var total float64
	for _, p := range d.Phases {
		total += p.DurationMs
	}
	check := func(tMs float64) {
		s, err := TargetAt(d, tMs)
		if err != nil {
			t.Fatal(err)
		}
		if s.Values[B] > ZeroTolerance && s.Values[T] > ZeroTolerance {
			t.Fatalf("overlap at t=%v: %+v in %+v", tMs, s, d)
		}
	}
	if math.IsInf(total, 0) || total > MaxDurationMs {
		t.Fatalf("accepted drill with total duration %v: %+v", total, d)
	}
	if s := ShapeAt(d, 0.25); s.Done {
		t.Fatalf("ShapeAt(0.25) reports done: %+v", s)
	}
	for i := 0; i <= 2000; i++ {
		check(total * float64(i) / 2000)
	}
	var start float64
	for _, p := range d.Phases { // every boundary and just either side of it
		for _, dt := range []float64{-1e-6, 0, 1e-6} {
			check(start + dt)
		}
		start += p.DurationMs
	}
}

func TestRandomDrillsNeverOverlap(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // deterministic test generator
	accepted := 0
	for range 3000 {
		d := randomDrill(r)
		if Validate(d, allAxes) == nil {
			accepted++
		}
		checkNoOverlap(t, d)
	}
	if accepted < 100 {
		t.Fatalf("generator too weak: only %d/3000 drills accepted", accepted)
	}
}

func FuzzTargetsNeverOverlap(f *testing.F) {
	f.Add(uint64(1), uint64(2))
	f.Add(uint64(42), uint64(7))
	f.Fuzz(func(t *testing.T, a, b uint64) {
		checkNoOverlap(t, randomDrill(rand.New(rand.NewPCG(a, b)))) //nolint:gosec // deterministic test generator
	})
}

func TestPhaseStarts(t *testing.T) {
	ramp := map[input.Axis]Ramp{input.AxisBrake: {From: 0.5, To: 0.5}}
	weighted := DrillDefinition{Phases: []Phase{{DurationMs: 1000, Targets: ramp}, {DurationMs: 3000, Targets: ramp}}}
	if got := PhaseStarts(weighted); len(got) != 2 || got[0] != 0 || got[1] != 0.25 {
		t.Errorf("weighted = %v", got)
	}
	equal := DrillDefinition{Phases: []Phase{{Targets: ramp}, {Targets: ramp}, {Targets: ramp}, {Targets: ramp}}}
	if got := PhaseStarts(equal); got[1] != 0.25 || got[3] != 0.75 {
		t.Errorf("equal = %v", got)
	}
}
