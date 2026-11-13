package engine

import (
	"math"

	"github.com/arush-sal/trail-braking-trainer/core/drills"
	"github.com/arush-sal/trail-braking-trainer/core/input"
)

var bst = []input.Axis{input.AxisBrake, input.AxisSteering, input.AxisThrottle}

func introduced(p drills.Phase, a input.Axis) bool {
	r, ok := p.Targets[a]
	return ok && math.Max(math.Abs(r.From), math.Abs(r.To)) > drills.ZeroTolerance
}

// GuidedPrimary returns the primary (foreground audio) control during phase
// i of a validated guided drill (R-011, spec 3.2). Ownership comes from the
// drill phases, never from magnitude: it is the latest control in B->S->T
// order introduced (desired above zero) in phases 0..i, so it only moves
// forward, and only at phase boundaries. Before any control is introduced
// (a leading coast phase) it is the first control the drill will introduce;
// for a drill that never leaves zero (e.g. a steering centre hold) it is the
// first selected control.
func GuidedPrimary(d drills.DrillDefinition, i int) input.Axis {
	owner, next := -1, -1
	for j, p := range d.Phases {
		for k, a := range bst {
			switch {
			case !introduced(p, a):
			case j <= i:
				owner = max(owner, k) // never moves backward
			case owner < 0 && next < 0:
				next = k
			}
		}
	}
	switch {
	case owner >= 0:
		return bst[owner]
	case next >= 0:
		return bst[next]
	default:
		return d.Controls[0]
	}
}

// PrimaryConfig tunes freeform primary selection. Values are PROPOSED
// defaults to be tuned with real users (spec section 14).
type PrimaryConfig struct {
	// EnterThreshold: a control engages when |value| >= EnterThreshold.
	EnterThreshold float64 `json:"enterThreshold"`
	// ExitThreshold: an engaged control disengages when |value| <
	// ExitThreshold (< EnterThreshold, so values hovering near zero do not
	// toggle engagement).
	ExitThreshold float64 `json:"exitThreshold"`
	// MinDwellMs: minimum time between primary switches; a pending switch
	// happens once the dwell has elapsed if it is still warranted.
	MinDwellMs float64 `json:"minDwellMs"`
}

// DefaultPrimaryConfig returns the PROPOSED defaults: enter 8%, exit 3%,
// 250 ms dwell.
func DefaultPrimaryConfig() PrimaryConfig {
	return PrimaryConfig{EnterThreshold: 0.08, ExitThreshold: 0.03, MinDwellMs: 250}
}

// FreeformPrimary picks the primary control when there is no target: the
// most recently engaged control that is still engaged. When nothing is
// engaged the previous primary is kept, so releasing everything never
// bounces the focus. Unavailable channels and gap/stale frames never
// engage a control; out-of-order frames are ignored.
type FreeformPrimary struct {
	cfg       PrimaryConfig
	controls  []input.Axis
	engagedAt map[input.Axis]float64 // present = engaged
	primary   input.Axis
	switched  float64
	seen      bool
	lastMs    float64
}

// NewFreeformPrimary tracks the selected controls only.
func NewFreeformPrimary(controls []input.Axis, cfg PrimaryConfig) *FreeformPrimary {
	return &FreeformPrimary{cfg: cfg, controls: controls, engagedAt: map[input.Axis]float64{}}
}

// Observe processes one frame and returns the current primary ("" until a
// control first engages) and whether it changed on this frame.
func (p *FreeformPrimary) Observe(f input.Frame) (input.Axis, bool) {
	if p.seen && f.ReceivedMonoMs < p.lastMs {
		return p.primary, false
	}
	p.seen, p.lastMs = true, f.ReceivedMonoMs
	if f.Quality.Gap || f.Quality.Stale {
		return p.primary, false // no usable values: keep engagement as it was
	}
	var cand input.Axis
	for _, a := range p.controls {
		v, ok := value(f, a)
		_, engaged := p.engagedAt[a]
		switch {
		case ok && !engaged && math.Abs(v) >= p.cfg.EnterThreshold:
			p.engagedAt[a] = f.ReceivedMonoMs
		case engaged && (!ok || math.Abs(v) < p.cfg.ExitThreshold):
			delete(p.engagedAt, a)
		}
		if at, engaged := p.engagedAt[a]; engaged && (cand == "" || at >= p.engagedAt[cand]) {
			cand = a
		}
	}
	if cand == "" || cand == p.primary || (p.primary != "" && f.ReceivedMonoMs-p.switched < p.cfg.MinDwellMs) {
		return p.primary, false
	}
	p.primary, p.switched = cand, f.ReceivedMonoMs
	return cand, true
}
