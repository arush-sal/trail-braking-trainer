package drills

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/input"
)

const (
	B = input.AxisBrake
	S = input.AxisSteering
	T = input.AxisThrottle
)

var allAxes = []input.Axis{B, S, T}

func hold(v float64) Ramp { return Ramp{From: v, To: v} }

func holdDrill(b float64) DrillDefinition {
	return DrillDefinition{
		SchemaVersion: SchemaVersion, Type: Hold, Timing: Timed, Controls: []input.Axis{B},
		Phases: []Phase{{DurationMs: 3000, Targets: map[input.Axis]Ramp{B: hold(b)}}},
	}
}

func sweepDrill() DrillDefinition {
	return DrillDefinition{
		SchemaVersion: SchemaVersion, Type: Sweep, Timing: Timed, Controls: []input.Axis{T},
		Phases: []Phase{{DurationMs: 1000, Targets: map[input.Axis]Ramp{T: {From: 0, To: 1}}}},
	}
}

func progressiveDrill() DrillDefinition {
	return DrillDefinition{
		SchemaVersion: SchemaVersion, Type: Progressive, Timing: SelfPaced, Controls: []input.Axis{B},
		Phases: []Phase{{Targets: map[input.Axis]Ramp{B: {From: 0.9, To: 0, Curve: EaseOut, Intensity: 1}}}},
	}
}

// trailBrake is the illustrative B -> B+S -> S -> S+T -> T pattern.
func trailBrake() DrillDefinition {
	return DrillDefinition{
		SchemaVersion: SchemaVersion, Name: "trail brake", Type: Multistage, Timing: Timed, Controls: allAxes,
		Phases: []Phase{
			{DurationMs: 1000, Targets: map[input.Axis]Ramp{B: hold(0.8)}},
			{DurationMs: 1500, Targets: map[input.Axis]Ramp{B: {From: 0.8, To: 0, Curve: EaseOut, Intensity: 1}, S: {From: 0, To: 0.5}}},
			{DurationMs: 1000, Targets: map[input.Axis]Ramp{S: hold(0.5)}},
			{DurationMs: 1500, Targets: map[input.Axis]Ramp{S: {From: 0.5, To: 0}, T: {From: 0, To: 1, Curve: EaseIn, Intensity: 1}}},
			{DurationMs: 1000, Targets: map[input.Axis]Ramp{T: hold(1)}},
		},
	}
}

func TestValidateSelection(t *testing.T) {
	ok := [][]input.Axis{{B}, {S}, {T}, {B, S}, {S, T}, {B, S, T}}
	for _, sel := range ok {
		if err := ValidateSelection(sel); err != nil {
			t.Errorf("%v rejected: %v", sel, err)
		}
	}
	bad := [][]input.Axis{nil, {B, T}, {T, B}, {S, B}, {B, B}, {"clutch"}, {B, S, T, T}, {T, S}}
	for _, sel := range bad {
		if err := ValidateSelection(sel); err == nil {
			t.Errorf("%v accepted", sel)
		}
	}
}

func TestValidate(t *testing.T) {
	type mut func(*DrillDefinition)
	tests := []struct {
		name    string
		base    func() DrillDefinition
		mut     mut
		avail   []input.Axis
		wantErr string // empty = valid
	}{
		{"hold ok", func() DrillDefinition { return holdDrill(0.4) }, nil, nil, ""},
		{"sweep ok", sweepDrill, nil, nil, ""},
		{"progressive self-paced ok", progressiveDrill, nil, nil, ""},
		{"trail brake ok", trailBrake, nil, nil, ""},
		{"B+S directly to S+T ok", trailBrake, func(d *DrillDefinition) {
			d.Phases = []Phase{
				{DurationMs: 1000, Targets: map[input.Axis]Ramp{B: {From: 0.6, To: 0}, S: {From: 0, To: 0.4}}},
				{DurationMs: 1000, Targets: map[input.Axis]Ramp{S: {From: 0.4, To: 0}, T: {From: 0, To: 0.7}}},
			}
		}, nil, ""},
		{"coast phase ok", trailBrake, func(d *DrillDefinition) {
			d.Controls = []input.Axis{B, S, T}
			d.Phases = []Phase{
				{DurationMs: 1000, Targets: map[input.Axis]Ramp{B: {From: 0.5, To: 0}}},
				{DurationMs: 500}, // coast: everything released
				{DurationMs: 1000, Targets: map[input.Axis]Ramp{T: {From: 0, To: 0.5}}},
			}
		}, nil, ""},
		{"self-paced multistage no durations ok", trailBrake, func(d *DrillDefinition) {
			d.Timing = SelfPaced
			for i := range d.Phases {
				d.Phases[i].DurationMs = 0
			}
		}, nil, ""},
		{"steering hold at centre ok", func() DrillDefinition { return holdDrill(0) }, func(d *DrillDefinition) {
			d.Controls = []input.Axis{S}
			d.Phases[0].Targets = map[input.Axis]Ramp{S: hold(0)}
		}, nil, ""},

		{"schema version", trailBrake, func(d *DrillDefinition) { d.SchemaVersion = 2 }, nil, "schemaVersion"},
		{"bad type", trailBrake, func(d *DrillDefinition) { d.Type = "zigzag" }, nil, "type"},
		{"bad timing", trailBrake, func(d *DrillDefinition) { d.Timing = "" }, nil, "timing"},
		{"bad difficulty", trailBrake, func(d *DrillDefinition) { d.Difficulty = "pro" }, nil, "difficulty"},
		{"B+T selection", trailBrake, func(d *DrillDefinition) {
			d.Controls = []input.Axis{B, T}
			d.Phases = []Phase{{DurationMs: 1, Targets: map[input.Axis]Ramp{B: hold(0)}}, {DurationMs: 1}}
		}, nil, "controls"},
		{"steering unavailable", trailBrake, nil, []input.Axis{B, T}, "steering: not available"},
		{"brake-only with steering unavailable ok", func() DrillDefinition { return holdDrill(0.4) }, nil, []input.Axis{B, T}, ""},
		{"brake > 1", func() DrillDefinition { return holdDrill(1.2) }, nil, nil, "phases[0].targets.brake.from"},
		{"throttle < 0", sweepDrill, func(d *DrillDefinition) { d.Phases[0].Targets[T] = Ramp{From: -0.1, To: 1} }, nil, "throttle.from"},
		{"steering > 1", trailBrake, func(d *DrillDefinition) { d.Phases[2].Targets[S] = hold(1.5) }, nil, "steering"},
		{"NaN target", func() DrillDefinition { return holdDrill(math.NaN()) }, nil, nil, "brake.from"},
		{"target on unselected control", func() DrillDefinition { return holdDrill(0.4) }, func(d *DrillDefinition) {
			d.Phases[0].Targets[S] = hold(0.1)
		}, nil, "not selected"},
		{"timed zero duration", trailBrake, func(d *DrillDefinition) { d.Phases[2].DurationMs = 0 }, nil, "phases[2].durationMs"},
		{"timed negative duration", sweepDrill, func(d *DrillDefinition) { d.Phases[0].DurationMs = -5 }, nil, "durationMs"},
		{"self-paced mixed durations", trailBrake, func(d *DrillDefinition) {
			d.Timing = SelfPaced
			d.Phases[0].DurationMs = 0
		}, nil, "durationMs"},
		{"overlapping B release and T ramp in one phase", trailBrake, func(d *DrillDefinition) {
			d.Type = Progressive
			d.Phases = []Phase{{DurationMs: 1000, Targets: map[input.Axis]Ramp{
				B: {From: 0.4, To: 0, Curve: EaseIn, Intensity: 4}, T: {From: 0, To: 0.3, Curve: EaseIn, Intensity: 4},
			}}}
		}, nil, "brake and throttle"},
		{"B+T hold in B+S+T drill", trailBrake, func(d *DrillDefinition) {
			d.Type = Hold
			d.Phases = []Phase{{DurationMs: 1000, Targets: map[input.Axis]Ramp{B: hold(0.2), T: hold(0.2)}}}
		}, nil, "brake and throttle"},
		{"brake after throttle", trailBrake, func(d *DrillDefinition) {
			d.Phases = append(d.Phases,
				Phase{DurationMs: 500, Targets: map[input.Axis]Ramp{T: {From: 1, To: 0}}},
				Phase{DurationMs: 500, Targets: map[input.Axis]Ramp{B: {From: 0, To: 0.5}}})
		}, nil, "brake after throttle"},
		{"steering introduced before brake", trailBrake, func(d *DrillDefinition) {
			d.Controls = []input.Axis{B, S}
			d.Phases = []Phase{
				{DurationMs: 500, Targets: map[input.Axis]Ramp{S: {From: 0, To: 0.3}}},
				{DurationMs: 500, Targets: map[input.Axis]Ramp{S: hold(0.3), B: {From: 0, To: 0.3}}},
			}
		}, nil, "order"},
		{"discontinuous phases", trailBrake, func(d *DrillDefinition) { d.Phases[1].Targets[B] = Ramp{From: 0.6, To: 0} }, nil, "discontinuous"},
		{"step to throttle without ramp", trailBrake, func(d *DrillDefinition) { d.Phases[3].Targets[T] = Ramp{From: 0.2, To: 1} }, nil, "discontinuous"},
		{"no phases", trailBrake, func(d *DrillDefinition) { d.Phases = nil }, nil, "phases"},
		{"hold with ramp", func() DrillDefinition { return holdDrill(0.4) }, func(d *DrillDefinition) { d.Phases[0].Targets[B] = Ramp{From: 0, To: 0.4} }, nil, "hold"},
		{"sweep with easing", sweepDrill, func(d *DrillDefinition) { d.Phases[0].Targets[T] = Ramp{From: 0, To: 1, Curve: EaseIn, Intensity: 1} }, nil, "linear"},
		{"sweep without movement", sweepDrill, func(d *DrillDefinition) { d.Phases[0].Targets[T] = hold(0.5) }, nil, "ramp"},
		{"progressive two phases", progressiveDrill, func(d *DrillDefinition) { d.Phases = append(d.Phases, Phase{}) }, nil, "exactly one phase"},
		{"multistage single phase", trailBrake, func(d *DrillDefinition) { d.Phases = d.Phases[:1] }, nil, "at least two"},
		{"bad curve", sweepDrill, func(d *DrillDefinition) { d.Type = Progressive; d.Phases[0].Targets[T] = Ramp{To: 1, Curve: "wobbly"} }, nil, "curve"},
		{"intensity too high", progressiveDrill, func(d *DrillDefinition) { d.Phases[0].Targets[B] = Ramp{From: 0.9, Curve: EaseOut, Intensity: 99} }, nil, "intensity"},
		{"self-paced ends in coast", trailBrake, func(d *DrillDefinition) {
			d.Timing = SelfPaced
			d.Phases = append(d.Phases, Phase{DurationMs: 500, Targets: map[input.Axis]Ramp{T: {From: 1, To: 0}}}, Phase{DurationMs: 500})
		}, nil, "terminal"},
		{"tolerance override <= 0", trailBrake, func(d *DrillDefinition) { d.ControlTolerance = map[input.Axis]float64{B: 0} }, nil, "controlTolerance.brake"},
		{"drill tolerance > 1", trailBrake, func(d *DrillDefinition) { d.Tolerance = 2 }, nil, "tolerance"},
		{"tolerance on unselected control", func() DrillDefinition { return holdDrill(0.4) }, func(d *DrillDefinition) {
			d.ControlTolerance = map[input.Axis]float64{T: 0.1}
		}, nil, "not selected"},
		{"negative rounds", trailBrake, func(d *DrillDefinition) { d.Rounds = -1 }, nil, "rounds"},
		{"negative rest", trailBrake, func(d *DrillDefinition) { d.RestMs = ptr(-1) }, nil, "restMs"},
		{"negative countdown", trailBrake, func(d *DrillDefinition) { d.CountdownMs = ptr(-1) }, nil, "countdownMs"},
		{"zero rest ok", trailBrake, func(d *DrillDefinition) { d.RestMs = ptr(0) }, nil, ""},
		{"phase duration over max", sweepDrill, func(d *DrillDefinition) { d.Phases[0].DurationMs = MaxDurationMs + 1 }, nil, "durationMs"},
		{"phase duration at max ok", sweepDrill, func(d *DrillDefinition) { d.Phases[0].DurationMs = MaxDurationMs }, nil, ""},
		{"huge durations overflow total", trailBrake, func(d *DrillDefinition) {
			for i := range d.Phases {
				d.Phases[i].DurationMs = 1e308
			}
		}, nil, "durationMs"},
		{"total duration over max", trailBrake, func(d *DrillDefinition) {
			for i := range d.Phases {
				d.Phases[i].DurationMs = MaxDurationMs / 2
			}
		}, nil, "total"},
		{"Inf duration", sweepDrill, func(d *DrillDefinition) { d.Phases[0].DurationMs = math.Inf(1) }, nil, "durationMs"},
		{"NaN duration", sweepDrill, func(d *DrillDefinition) { d.Phases[0].DurationMs = math.NaN() }, nil, "durationMs"},
		{"Inf target", sweepDrill, func(d *DrillDefinition) { d.Phases[0].Targets[T] = Ramp{From: 0, To: math.Inf(1)} }, nil, "throttle.to"},
		{"NaN intensity", progressiveDrill, func(d *DrillDefinition) {
			d.Phases[0].Targets[B] = Ramp{From: 0.9, Curve: EaseOut, Intensity: math.NaN()}
		}, nil, "intensity"},
		{"Inf intensity", progressiveDrill, func(d *DrillDefinition) {
			d.Phases[0].Targets[B] = Ramp{From: 0.9, Curve: EaseOut, Intensity: math.Inf(1)}
		}, nil, "intensity"},
		{"NaN drill tolerance", trailBrake, func(d *DrillDefinition) { d.Tolerance = math.NaN() }, nil, "tolerance"},
		{"NaN control tolerance", trailBrake, func(d *DrillDefinition) { d.ControlTolerance = map[input.Axis]float64{S: math.NaN()} }, nil, "controlTolerance.steering"},
		{"NaN completion hold", trailBrake, func(d *DrillDefinition) { d.CompletionHoldMs = math.NaN() }, nil, "completionHoldMs"},
		{"Inf completion hold", trailBrake, func(d *DrillDefinition) { d.CompletionHoldMs = math.Inf(1) }, nil, "completionHoldMs"},
		{"completion hold over max", trailBrake, func(d *DrillDefinition) { d.CompletionHoldMs = MaxDurationMs + 1 }, nil, "completionHoldMs"},
		{"NaN rest", trailBrake, func(d *DrillDefinition) { d.RestMs = ptr(math.NaN()) }, nil, "restMs"},
		{"Inf rest", trailBrake, func(d *DrillDefinition) { d.RestMs = ptr(math.Inf(1)) }, nil, "restMs"},
		{"rest over max", trailBrake, func(d *DrillDefinition) { d.RestMs = ptr(MaxDurationMs + 1) }, nil, "restMs"},
		{"Inf countdown", trailBrake, func(d *DrillDefinition) { d.CountdownMs = ptr(math.Inf(1)) }, nil, "countdownMs"},
		{"countdown over max", trailBrake, func(d *DrillDefinition) { d.CountdownMs = ptr(MaxDurationMs + 1) }, nil, "countdownMs"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := tc.base()
			if tc.mut != nil {
				tc.mut(&d)
			}
			avail := tc.avail
			if avail == nil {
				avail = allAxes
			}
			err := Validate(d, avail)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func ptr(v float64) *float64 { return &v }

func TestWithDefaults(t *testing.T) {
	d := trailBrake().WithDefaults()
	if d.Rounds != 8 || *d.RestMs != 5000 || *d.CountdownMs != 3000 || d.Difficulty != Beginner {
		t.Fatalf("defaults: rounds=%d rest=%v countdown=%v difficulty=%q", d.Rounds, *d.RestMs, *d.CountdownMs, d.Difficulty)
	}
	d = trailBrake()
	d.Rounds, d.RestMs, d.Difficulty = 3, ptr(0), Advanced
	d = d.WithDefaults()
	if d.Rounds != 3 || *d.RestMs != 0 || d.Difficulty != Advanced {
		t.Fatalf("explicit values overwritten: %+v", d)
	}
}

func TestToleranceFor(t *testing.T) {
	d := trailBrake()
	if got := d.ToleranceFor(B); got != Presets[Beginner].Tolerance {
		t.Fatalf("preset default: %v", got)
	}
	d.Difficulty = Advanced
	if got := d.ToleranceFor(B); got != Presets[Advanced].Tolerance {
		t.Fatalf("advanced preset: %v", got)
	}
	d.Tolerance = 0.07
	if got := d.ToleranceFor(S); got != 0.07 {
		t.Fatalf("drill override: %v", got)
	}
	d.ControlTolerance = map[input.Axis]float64{S: 0.02}
	if d.ToleranceFor(S) != 0.02 || d.ToleranceFor(B) != 0.07 {
		t.Fatalf("control override precedence: S=%v B=%v", d.ToleranceFor(S), d.ToleranceFor(B))
	}
	if d.CompletionHoldMsFor() != Presets[Advanced].CompletionHoldMs {
		t.Fatalf("completion hold preset: %v", d.CompletionHoldMsFor())
	}
	d.CompletionHoldMs = 250
	if d.CompletionHoldMsFor() != 250 {
		t.Fatalf("completion hold override: %v", d.CompletionHoldMsFor())
	}
}

func TestJSONRoundTrip(t *testing.T) {
	d := trailBrake().WithDefaults()
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{`"schemaVersion":1`, `"type":"multistage"`, `"timing":"timed"`, `"controls":["brake","steering","throttle"]`,
		`"durationMs":1000`, `"targets":{"brake":{"from":0.8,"to":0.8}}`, `"curve":"easeOut"`, `"restMs":5000`, `"countdownMs":3000`, `"rounds":8`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("JSON missing %s in %s", k, b)
		}
	}
	var back DrillDefinition
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, d) {
		t.Fatalf("round trip mismatch:\n%+v\n%+v", back, d)
	}
}
