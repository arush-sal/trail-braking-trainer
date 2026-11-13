// Package engine holds the pure, frame-driven training detectors: actual
// brake/throttle overlap (R-010), self-paced auto-completion (R-017) and
// primary-control selection (R-011). Every detector is driven only by
// input.Frame values and their monotonic ReceivedMonoMs; no wall clock.
//
// Shared frame rules: a frame older than the last accepted one is ignored
// (out-of-order); a frame flagged gap or stale carries no usable values; an
// unavailable channel (null) is never treated as 0 or as active.
package engine

import "github.com/arush-sal/trail-braking-trainer/core/input"

// value returns a channel's normalized value, or false when it is
// unavailable or the frame is a gap/stale sample.
func value(f input.Frame, a input.Axis) (float64, bool) {
	if f.Quality.Gap || f.Quality.Stale {
		return 0, false
	}
	m := f.Brake
	switch a {
	case input.AxisSteering:
		m = f.Steering
	case input.AxisThrottle:
		m = f.Throttle
	}
	if !m.Available || m.Normalized == nil {
		return 0, false
	}
	return *m.Normalized, true
}

// OverlapConfig tunes the actual B+T overlap detector. Values are PROPOSED
// defaults to be tuned on hardware (spec section 14), not validated limits.
type OverlapConfig struct {
	// EnterThreshold: overlap starts when brake and throttle are both
	// >= EnterThreshold + NoiseFloor.
	EnterThreshold float64 `json:"enterThreshold"`
	// ExitThreshold: overlap ends when either drops below
	// ExitThreshold + NoiseFloor (ExitThreshold < EnterThreshold).
	ExitThreshold float64 `json:"exitThreshold"`
	// NoiseFloor is the measured sensor noise of the source, added to both
	// thresholds so resting jitter never reads as pressure.
	NoiseFloor float64 `json:"noiseFloor"`
	// CooldownMs: after an exit, a new onset is only reported once this long
	// has passed; re-entry inside the cooldown continues the same episode.
	CooldownMs float64 `json:"cooldownMs"`
}

// DefaultOverlapConfig returns the PROPOSED defaults: enter 5%, exit 2%,
// noise floor 0.005, cooldown 500 ms.
func DefaultOverlapConfig() OverlapConfig {
	return OverlapConfig{EnterThreshold: 0.05, ExitThreshold: 0.02, NoiseFloor: DefaultNoiseFloor, CooldownMs: 500}
}

// DefaultNoiseFloor (~one 8-bit step) is provisional, public-info
// inference, to be measured in hardware test T2.
const DefaultNoiseFloor = 0.005

// OverlapEvent is one overlap onset with the unsuppressed actual values.
type OverlapEvent struct {
	AtMs     float64 `json:"atMs"`
	Brake    float64 `json:"brake"`
	Throttle float64 `json:"throttle"`
}

// OverlapDetector flags actual brake+throttle overlap (spec 3.2). It never
// modifies inputs and never ends or resets an attempt; it only reports one
// onset event per episode.
type OverlapDetector struct {
	cfg      OverlapConfig
	active   bool
	had      bool    // an episode has ended at least once
	exitedAt float64 // when the last episode ended (valid when had)
	seen     bool
	lastMs   float64
}

// NewOverlapDetector returns a detector with cfg.
func NewOverlapDetector(cfg OverlapConfig) *OverlapDetector { return &OverlapDetector{cfg: cfg} }

// Active reports whether an overlap episode is in progress.
func (d *OverlapDetector) Active() bool { return d.active }

// Observe processes one frame and returns an onset event on entry to a new
// overlap episode.
func (d *OverlapDetector) Observe(f input.Frame) (OverlapEvent, bool) {
	if d.seen && f.ReceivedMonoMs < d.lastMs {
		return OverlapEvent{}, false
	}
	d.seen, d.lastMs = true, f.ReceivedMonoMs
	b, okB := value(f, input.AxisBrake)
	t, okT := value(f, input.AxisThrottle)
	both := func(th float64) bool { return okB && okT && b >= th+d.cfg.NoiseFloor && t >= th+d.cfg.NoiseFloor }
	if d.active {
		if !both(d.cfg.ExitThreshold) {
			d.active, d.had, d.exitedAt = false, true, f.ReceivedMonoMs
		}
		return OverlapEvent{}, false
	}
	if !both(d.cfg.EnterThreshold) {
		return OverlapEvent{}, false
	}
	d.active = true
	if d.had && f.ReceivedMonoMs-d.exitedAt < d.cfg.CooldownMs {
		return OverlapEvent{}, false // re-entry inside cooldown: same episode
	}
	return OverlapEvent{AtMs: f.ReceivedMonoMs, Brake: b, Throttle: t}, true
}
