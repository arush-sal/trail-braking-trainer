package drills

import (
	"fmt"

	"github.com/arush-sal/trail-braking-trainer/core/input"
)

// Sample is the desired state at one instant (TargetAt) or one normalized
// progress point (ShapeAt).
type Sample struct {
	// Phase is the index of the owning phase. A boundary instant belongs to
	// the phase that starts there; after the end it is the last phase.
	Phase int `json:"phase"`
	// Values holds the desired value of every selected control. A control
	// absent from the map is not part of the drill.
	Values map[input.Axis]float64 `json:"values"`
	// Terminal lists the controls with an explicit final-state target (the
	// controls the last phase lists), used for self-paced completion.
	Terminal []input.Axis `json:"terminal"`
	// Done is true once the drill's end has been reached.
	Done bool `json:"done"`
}

// TerminalTargets returns the final desired value of every terminal control
// (the controls the last phase lists explicitly).
func TerminalTargets(d DrillDefinition) map[input.Axis]float64 {
	last := d.Phases[len(d.Phases)-1]
	out := make(map[input.Axis]float64, len(last.Targets))
	for a, r := range last.Targets {
		out[a] = r.To
	}
	return out
}

// TargetAt returns the desired state of a validated timed drill at tMs of
// elapsed exercise time (clamped to >= 0). Self-paced drills have no
// instantaneous desired position (spec 3.4) and return an error; compare
// them retrospectively with ShapeAt.
func TargetAt(d DrillDefinition, tMs float64) (Sample, error) {
	if d.Timing != Timed {
		return Sample{}, fmt.Errorf("TargetAt: %s drill has no instantaneous target; use ShapeAt on normalized progress", d.Timing)
	}
	w := make([]float64, len(d.Phases))
	for i, p := range d.Phases {
		w[i] = p.DurationMs
	}
	return sampleAt(d, w, tMs), nil
}

// ShapeAt returns the desired state at normalized progress u in [0,1]
// (clamped) of a validated drill. Phases are weighted by DurationMs when set,
// otherwise equally. For a timed drill ShapeAt(d, t/total) == TargetAt(d, t).
func ShapeAt(d DrillDefinition, u float64) Sample {
	w := make([]float64, len(d.Phases))
	var total float64
	for i, p := range d.Phases {
		w[i] = p.DurationMs
		total += w[i]
	}
	if total <= 0 {
		for i := range w {
			w[i] = 1
		}
		total = float64(len(w))
	}
	return sampleAt(d, w, u*total)
}

// sampleAt locates x on the cumulative phase weights w. Phase i owns
// [start_i, start_i + w_i); x at or past the end maps to the last phase at
// local progress 1.
func sampleAt(d DrillDefinition, w []float64, x float64) Sample {
	x = max(x, 0)
	phase, local, done := len(w)-1, 1.0, true
	var start float64
	for i, wi := range w {
		if x < start+wi {
			phase, local, done = i, (x-start)/wi, false
			break
		}
		start += wi
	}
	s := Sample{Phase: phase, Values: make(map[input.Axis]float64, len(d.Controls)), Done: done}
	p := d.Phases[phase]
	for _, a := range d.Controls {
		s.Values[a] = p.ramp(a).At(local)
	}
	for _, a := range d.Controls {
		if _, ok := d.Phases[len(d.Phases)-1].Targets[a]; ok {
			s.Terminal = append(s.Terminal, a)
		}
	}
	return s
}
