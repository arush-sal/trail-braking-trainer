package engine

import (
	"math"

	"github.com/arush-sal/trail-braking-trainer/core/drills"
	"github.com/arush-sal/trail-braking-trainer/core/input"
)

// CompletionConfig tunes self-paced auto-completion. Values are PROPOSED
// defaults, tunable after user testing (spec section 14).
type CompletionConfig struct {
	// ExitScale widens the band a hold must leave to reset: a hold starts
	// when every terminal control is within its tolerance and is kept while
	// each stays within tolerance*ExitScale (hysteresis, >= 1).
	ExitScale float64 `json:"exitScale"`
	// MaxFrameGapMs: consecutive accepted frames further apart than this
	// are a silent dropout and reset the hold (a dropped sample is never
	// assumed to be a steady input, spec 4.1).
	MaxFrameGapMs float64 `json:"maxFrameGapMs"`
}

// DefaultCompletionConfig returns the PROPOSED defaults: exit band 1.25x
// tolerance, 100 ms max frame gap.
func DefaultCompletionConfig() CompletionConfig {
	return CompletionConfig{ExitScale: 1.25, MaxFrameGapMs: 100}
}

// CompletionDetector implements self-paced `auto` completion (spec 3.5):
// every terminal control of the drill (drills.TerminalTargets) must stay
// within tolerance continuously for the drill's completion hold time. A
// fly-through shorter than the hold never completes. Gap/stale frames,
// unavailable terminal channels, out-of-order frames and frame gaps over
// MaxFrameGapMs never count and reset the hold. Completion latches until
// Reset. Completion is not a score: endpoint error is measured separately.
//
// *CompletionDetector satisfies session.Completion (Observe + Reset), so the
// session can drive it and reset it per attempt without importing engine.
type CompletionDetector struct {
	cfg       CompletionConfig
	targets   map[input.Axis]float64
	tolerance map[input.Axis]float64
	holdMs    float64

	holding  bool
	since    float64
	seen     bool
	lastMs   float64
	complete bool
}

// NewCompletionDetector builds a detector for a validated drill definition.
func NewCompletionDetector(d drills.DrillDefinition, cfg CompletionConfig) *CompletionDetector {
	c := &CompletionDetector{cfg: cfg, targets: drills.TerminalTargets(d), tolerance: map[input.Axis]float64{}, holdMs: d.CompletionHoldMsFor()}
	for a := range c.targets {
		c.tolerance[a] = d.ToleranceFor(a)
	}
	return c
}

// Reset clears the hold and any latched completion (new round).
func (c *CompletionDetector) Reset() {
	c.holding, c.seen, c.complete = false, false, false
}

// Observe processes one frame and reports whether the drill is complete.
func (c *CompletionDetector) Observe(f input.Frame) bool {
	if c.complete {
		return true
	}
	if c.seen && f.ReceivedMonoMs < c.lastMs {
		return false // out-of-order: ignored entirely
	}
	gap := c.seen && f.ReceivedMonoMs-c.lastMs > c.cfg.MaxFrameGapMs
	c.seen, c.lastMs = true, f.ReceivedMonoMs

	scale := 1.0
	if c.holding && !gap {
		scale = c.cfg.ExitScale
	}
	if !c.within(f, scale) {
		c.holding = false
		return false
	}
	if !c.holding || gap {
		c.holding, c.since = true, f.ReceivedMonoMs
	}
	c.complete = len(c.targets) > 0 && f.ReceivedMonoMs-c.since >= c.holdMs
	return c.complete
}

func (c *CompletionDetector) within(f input.Frame, scale float64) bool {
	for a, target := range c.targets {
		v, ok := value(f, a)
		if !ok || math.Abs(v-target) > c.tolerance[a]*scale {
			return false
		}
	}
	return true
}
