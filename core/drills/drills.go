// Package drills defines the versioned DrillDefinition schema, its
// validation (control selection, B->S->T phase order and the hard desired
// brake/throttle exclusion of spec 3.2) and deterministic target generation.
package drills

import (
	"fmt"
	"maps"
	"math"
	"slices"

	"github.com/arush-sal/trail-braking-trainer/core/input"
)

// SchemaVersion of DrillDefinition (ADR 0006).
const SchemaVersion = 1

// ZeroTolerance is the target-zero tolerance for desired values: a desired
// brake/throttle above it counts as "positive" for the B/T exclusion and
// phase-order rules. It only absorbs float rounding; authored targets must
// be truly 0 to count as released.
const ZeroTolerance = 1e-9

// MaxDurationMs bounds every duration in a definition (each phase, the
// phase total, completion hold, rest, countdown): 1 hour, matching the
// session package's limit. It also keeps cumulative phase sums finite.
const MaxDurationMs = 3_600_000.0

// DrillType selects the drill family (R-021).
type DrillType string

// Drill types.
const (
	Hold        DrillType = "hold"        // one phase, every target From == To
	Sweep       DrillType = "sweep"       // one phase, linear ramps only, at least one moving target
	Progressive DrillType = "progressive" // one phase, eased ramps, at least one moving target
	Multistage  DrillType = "multistage"  // two or more phases
)

// TimingMode selects timed or self-paced execution (R-016).
type TimingMode string

// Timing modes.
const (
	Timed     TimingMode = "timed"
	SelfPaced TimingMode = "selfPaced"
)

// Difficulty names a precision preset (R-023).
type Difficulty string

// Difficulties.
const (
	Beginner     Difficulty = "beginner"
	Intermediate Difficulty = "intermediate"
	Advanced     Difficulty = "advanced"
)

// Preset holds the precision defaults for a difficulty.
type Preset struct {
	// Tolerance is the allowed |actual - desired| on the normalized scale
	// (brake/throttle [0,1], provisional steering [-1,1]).
	Tolerance float64 `json:"tolerance"`
	// CompletionHoldMs is how long all terminal controls must stay within
	// tolerance for self-paced auto-completion (spec 3.5).
	CompletionHoldMs float64 `json:"completionHoldMs"`
}

// Presets are PROPOSED defaults (R-023), to be tuned with real users; they
// are not validated thresholds.
var Presets = map[Difficulty]Preset{
	Beginner:     {Tolerance: 0.10, CompletionHoldMs: 500},
	Intermediate: {Tolerance: 0.05, CompletionHoldMs: 750},
	Advanced:     {Tolerance: 0.025, CompletionHoldMs: 1000},
}

// Session defaults: rounds per R-019; rest and countdown are PROPOSED
// (spec 3.5 / section 14) and configurable.
const (
	DefaultRounds      = 8
	DefaultRestMs      = 5000.0
	DefaultCountdownMs = 3000.0
)

// Ramp is one control's desired trajectory across a phase:
// value(u) = From + (To-From) * Ease(Curve, Intensity, u), u in [0,1].
// A hold is From == To.
type Ramp struct {
	From      float64 `json:"from"`
	To        float64 `json:"to"`
	Curve     Curve   `json:"curve,omitempty"`
	Intensity float64 `json:"intensity,omitempty"`
}

// At returns the ramp value at local progress u.
func (r Ramp) At(u float64) float64 { return r.From + (r.To-r.From)*Ease(r.Curve, r.Intensity, u) }

// Phase is one segment of a drill. A selected control absent from Targets
// is desired at 0 (released / centred) for the whole phase, so a phase with
// no targets is a coast phase and one with only steering is steering-only.
type Phase struct {
	Name       string              `json:"name,omitempty"`
	DurationMs float64             `json:"durationMs,omitempty"`
	Targets    map[input.Axis]Ramp `json:"targets,omitempty"`
}

func (p Phase) ramp(a input.Axis) Ramp { return p.Targets[a] } // absent -> zero hold

// DrillDefinition is the versioned drill schema (ADR 0006). Targets are
// deterministic from the definition alone.
type DrillDefinition struct {
	SchemaVersion int          `json:"schemaVersion"`
	Name          string       `json:"name,omitempty"`
	Type          DrillType    `json:"type"`
	Timing        TimingMode   `json:"timing"`
	Controls      []input.Axis `json:"controls"`
	Phases        []Phase      `json:"phases"`
	Difficulty    Difficulty   `json:"difficulty,omitempty"`
	// Tolerance overrides the preset for every control in this drill.
	Tolerance float64 `json:"tolerance,omitempty"`
	// ControlTolerance overrides Tolerance and the preset per control.
	ControlTolerance map[input.Axis]float64 `json:"controlTolerance,omitempty"`
	// CompletionHoldMs overrides the preset auto-completion hold time.
	CompletionHoldMs float64  `json:"completionHoldMs,omitempty"`
	Rounds           int      `json:"rounds,omitempty"`
	RestMs           *float64 `json:"restMs,omitempty"`      // nil = default; 0 is a valid explicit value
	CountdownMs      *float64 `json:"countdownMs,omitempty"` // nil = default; 0 is a valid explicit value
}

// WithDefaults fills unset Difficulty, Rounds, RestMs and CountdownMs.
func (d DrillDefinition) WithDefaults() DrillDefinition {
	if d.Difficulty == "" {
		d.Difficulty = Beginner
	}
	if d.Rounds == 0 {
		d.Rounds = DefaultRounds
	}
	if d.RestMs == nil {
		v := DefaultRestMs
		d.RestMs = &v
	}
	if d.CountdownMs == nil {
		v := DefaultCountdownMs
		d.CountdownMs = &v
	}
	return d
}

func (d DrillDefinition) preset() Preset {
	if p, ok := Presets[d.Difficulty]; ok {
		return p
	}
	return Presets[Beginner]
}

// ToleranceFor resolves a control's tolerance: ControlTolerance, then the
// drill-wide Tolerance, then the difficulty preset.
func (d DrillDefinition) ToleranceFor(a input.Axis) float64 {
	if v, ok := d.ControlTolerance[a]; ok {
		return v
	}
	if d.Tolerance != 0 {
		return d.Tolerance
	}
	return d.preset().Tolerance
}

// CompletionHoldMsFor resolves the auto-completion hold time.
func (d DrillDefinition) CompletionHoldMsFor() float64 {
	if d.CompletionHoldMs != 0 {
		return d.CompletionHoldMs
	}
	return d.preset().CompletionHoldMs
}

var order = []input.Axis{input.AxisBrake, input.AxisSteering, input.AxisThrottle}

func valueRange(a input.Axis) (lo, hi float64) {
	if a == input.AxisSteering {
		return -1, 1 // provisional signed practice scale (ADR 0003)
	}
	return 0, 1
}

// ValidateSelection accepts only the contiguous B->S->T ranges [B], [S], [T],
// [B,S], [S,T], [B,S,T], in that order (R-008). B+T is rejected.
func ValidateSelection(sel []input.Axis) error {
	if len(sel) == 0 {
		return fmt.Errorf("controls: select at least one control")
	}
	start := slices.Index(order, sel[0])
	if start < 0 || start+len(sel) > len(order) || !slices.Equal(sel, order[start:start+len(sel)]) {
		return fmt.Errorf("controls: %v is not one of [B] [S] [T] [B,S] [S,T] [B,S,T] in B->S->T order", sel)
	}
	return nil
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// active reports whether control a is desired above target-zero anywhere in
// phase p. Curves are monotone, so the extremes of a ramp are its endpoints.
func active(p Phase, a input.Axis) bool {
	r := p.ramp(a)
	return math.Max(math.Abs(r.From), math.Abs(r.To)) > ZeroTolerance
}

// Validate checks a definition against the schema, the available input
// channels and the training invariants. It returns the first problem found.
//
// Invariants enforced (spec 3.2, 3.3 item 4):
//   - Within a phase, brake and throttle are never both desired above
//     ZeroTolerance at either endpoint. Ramps are monotone between their
//     endpoints, so a control at or below ZeroTolerance at both endpoints
//     stays there for every instant of the segment: the check is analytic
//     and conservative. A B release and a T application must therefore be
//     in different phases, i.e. B reaches 0 before T rises.
//   - Phases are continuous: each control's value at the end of one phase
//     equals its value at the start of the next (no scheduled steps), so the
//     value at a boundary is the same whichever side owns it.
//   - Controls are first introduced in B->S->T order, and brake is never
//     desired again once throttle has been introduced.
func Validate(d DrillDefinition, available []input.Axis) error {
	d = d.WithDefaults()
	if d.SchemaVersion != SchemaVersion {
		return fmt.Errorf("schemaVersion: must be %d, got %d", SchemaVersion, d.SchemaVersion)
	}
	switch d.Type {
	case Hold, Sweep, Progressive, Multistage:
	default:
		return fmt.Errorf("type: unknown %q", d.Type)
	}
	if d.Timing != Timed && d.Timing != SelfPaced {
		return fmt.Errorf("timing: unknown %q", d.Timing)
	}
	if _, ok := Presets[d.Difficulty]; !ok {
		return fmt.Errorf("difficulty: unknown %q", d.Difficulty)
	}
	if err := ValidateSelection(d.Controls); err != nil {
		return err
	}
	for _, a := range d.Controls {
		if !slices.Contains(available, a) {
			return fmt.Errorf("controls: %s: not available from the current source", a)
		}
	}
	if err := validateSettings(d); err != nil {
		return err
	}
	if err := validateShape(d); err != nil {
		return err
	}
	return validatePhases(d)
}

func validateSettings(d DrillDefinition) error {
	if d.Tolerance != 0 && !(d.Tolerance > 0 && d.Tolerance <= 1) {
		return fmt.Errorf("tolerance: must be in (0,1], got %v", d.Tolerance)
	}
	for _, a := range slices.Sorted(maps.Keys(d.ControlTolerance)) {
		if !slices.Contains(d.Controls, a) {
			return fmt.Errorf("controlTolerance.%s: control not selected", a)
		}
		if v := d.ControlTolerance[a]; !(v > 0 && v <= 1) {
			return fmt.Errorf("controlTolerance.%s: must be in (0,1], got %v", a, v)
		}
	}
	if d.CompletionHoldMs != 0 && !(d.CompletionHoldMs > 0 && d.CompletionHoldMs <= MaxDurationMs) {
		return fmt.Errorf("completionHoldMs: must be in (0,%v], got %v", MaxDurationMs, d.CompletionHoldMs)
	}
	if d.Rounds < 1 {
		return fmt.Errorf("rounds: must be >= 1, got %d", d.Rounds)
	}
	if !(*d.RestMs >= 0 && *d.RestMs <= MaxDurationMs) {
		return fmt.Errorf("restMs: must be in [0,%v], got %v", MaxDurationMs, *d.RestMs)
	}
	if !(*d.CountdownMs >= 0 && *d.CountdownMs <= MaxDurationMs) {
		return fmt.Errorf("countdownMs: must be in [0,%v], got %v", MaxDurationMs, *d.CountdownMs)
	}
	return nil
}

// validateShape checks per-type structure and per-phase values.
func validateShape(d DrillDefinition) error {
	if len(d.Phases) == 0 {
		return fmt.Errorf("phases: at least one phase required")
	}
	if d.Type == Multistage && len(d.Phases) < 2 {
		return fmt.Errorf("phases: multistage needs at least two phases")
	}
	if d.Type != Multistage && len(d.Phases) != 1 {
		return fmt.Errorf("phases: %s drill needs exactly one phase", d.Type)
	}
	positive, total := 0, 0.0
	for i, p := range d.Phases {
		if !(p.DurationMs >= 0 && p.DurationMs <= MaxDurationMs) {
			return fmt.Errorf("phases[%d].durationMs: must be in [0,%v], got %v", i, MaxDurationMs, p.DurationMs)
		}
		if total += p.DurationMs; total > MaxDurationMs {
			return fmt.Errorf("phases[%d].durationMs: total duration %v exceeds %v", i, total, MaxDurationMs)
		}
		if p.DurationMs > 0 {
			positive++
		}
		if d.Timing == Timed && p.DurationMs <= 0 {
			return fmt.Errorf("phases[%d].durationMs: timed drills need a positive duration", i)
		}
		for _, a := range slices.Sorted(maps.Keys(p.Targets)) {
			if !slices.Contains(d.Controls, a) {
				return fmt.Errorf("phases[%d].targets.%s: control not selected", i, a)
			}
		}
		for _, a := range d.Controls {
			r, ok := p.Targets[a]
			if !ok {
				continue
			}
			if err := validateRamp(fmt.Sprintf("phases[%d].targets.%s", i, a), a, r); err != nil {
				return err
			}
		}
	}
	if positive != 0 && positive != len(d.Phases) {
		return fmt.Errorf("phases[*].durationMs: self-paced phase weights must be all set or all omitted")
	}
	if d.Timing == SelfPaced && len(d.Phases[len(d.Phases)-1].Targets) == 0 {
		return fmt.Errorf("phases: self-paced drills need at least one terminal target in the last phase")
	}
	moving, eased := false, false
	for _, r := range d.Phases[0].Targets {
		moving = moving || r.From != r.To
		eased = eased || (r.Curve != "" && r.Curve != Linear && r.From != r.To)
	}
	switch {
	case d.Type == Hold && moving:
		return fmt.Errorf("phases[0]: hold drill targets need from == to")
	case (d.Type == Sweep || d.Type == Progressive) && !moving:
		return fmt.Errorf("phases[0]: %s drill needs at least one ramp (from != to)", d.Type)
	case d.Type == Sweep && eased:
		return fmt.Errorf("phases[0]: sweep drill ramps must be linear")
	}
	return nil
}

func validateRamp(path string, a input.Axis, r Ramp) error {
	lo, hi := valueRange(a)
	for _, v := range []struct {
		name string
		v    float64
	}{{"from", r.From}, {"to", r.To}} {
		if !finite(v.v) || v.v < lo || v.v > hi {
			return fmt.Errorf("%s.%s: %v outside [%v,%v]", path, v.name, v.v, lo, hi)
		}
	}
	switch r.Curve {
	case "", Linear, EaseIn, EaseOut, EaseInOut:
	default:
		return fmt.Errorf("%s.curve: unknown %q", path, r.Curve)
	}
	if !(r.Intensity >= 0 && r.Intensity <= MaxIntensity) {
		return fmt.Errorf("%s.intensity: must be in [0,%v], got %v", path, MaxIntensity, r.Intensity)
	}
	return nil
}

// validatePhases enforces continuity, B/T exclusion and B->S->T order.
func validatePhases(d DrillDefinition) error {
	first := map[input.Axis]int{}
	for i, p := range d.Phases {
		if active(p, input.AxisBrake) && active(p, input.AxisThrottle) {
			return fmt.Errorf("phases[%d]: brake and throttle are both desired above zero; release brake to 0 in an earlier phase before throttle rises", i)
		}
		if i > 0 {
			for _, a := range d.Controls {
				if prev, next := d.Phases[i-1].ramp(a).To, p.ramp(a).From; math.Abs(prev-next) > ZeroTolerance {
					return fmt.Errorf("phases[%d].targets.%s: discontinuous: previous phase ends at %v, this one starts at %v", i, a, prev, next)
				}
			}
		}
		for _, a := range d.Controls {
			if _, seen := first[a]; !seen && active(p, a) {
				first[a] = i
			}
		}
		if t, ok := first[input.AxisThrottle]; ok && i > t && active(p, input.AxisBrake) {
			return fmt.Errorf("phases[%d]: brake after throttle violates B->S->T order", i)
		}
	}
	for k := 1; k < len(order); k++ {
		for j := range k {
			fj, okj := first[order[j]]
			fk, okk := first[order[k]]
			if okj && okk && fk < fj {
				return fmt.Errorf("phases[%d]: %s introduced before %s violates B->S->T order", fk, order[k], order[j])
			}
		}
	}
	return nil
}
