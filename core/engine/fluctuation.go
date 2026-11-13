package engine

import "github.com/arush-sal/trail-braking-trainer/core/input"

// FluctuationConfig tunes the unwanted-fluctuation detector (R-013, spec
// 3.1/6.1). Values are PROPOSED defaults to be tuned on hardware and with
// users (spec section 14), not validated limits.
type FluctuationConfig struct {
	// Amplitude: a swing only counts once the value has moved at least
	// Amplitude + NoiseFloor away from the last extreme (zig-zag filter), so
	// sensor noise and tiny corrections never count as a direction change.
	Amplitude float64 `json:"amplitude"`
	// NoiseFloor is the measured sensor noise of the source.
	NoiseFloor float64 `json:"noiseFloor"`
	// MinReversals direction reversals of counted swings within WindowMs
	// raise one alert. A single intentional up-then-down movement is one
	// reversal and never alerts.
	MinReversals int `json:"minReversals"`
	// WindowMs is the reversal-counting window and the quiet time (no
	// reversal) after which an alerted axis re-arms.
	WindowMs float64 `json:"windowMs"`
}

// DefaultFluctuationConfig returns the PROPOSED defaults: 3% swing, noise
// floor DefaultNoiseFloor (provisional, public-info inference, to be measured
// in hardware test T2), 3 reversals within 1000 ms (an oscillation of
// about 1.5 Hz or faster), re-arm after 1000 ms without a reversal.
func DefaultFluctuationConfig() FluctuationConfig {
	return FluctuationConfig{Amplitude: 0.03, NoiseFloor: DefaultNoiseFloor, MinReversals: 3, WindowMs: 1000}
}

// FluctuationEvent is one fluctuation onset on one axis.
type FluctuationEvent struct {
	AtMs float64    `json:"atMs"`
	Axis input.Axis `json:"axis"`
}

type swing struct {
	dir      int     // +1 rising, -1 falling, 0 not yet established
	ext      float64 // running extreme in dir (anchor while dir == 0)
	seen     bool
	revs     []float64 // reversal times inside the window
	alerting bool
	lastRev  float64
}

// FluctuationDetector flags oscillation/jitter per selected axis: repeated
// direction reversals of swings larger than the noise-adjusted amplitude
// within a short window. Rate of change alone never alerts, so smooth fast
// or slow monotonic motion is fine (spec 7: high intentional derivative is
// not an error). One alert per episode; an axis re-arms after WindowMs
// without a reversal. Gap/stale frames and unavailable channels reset that
// axis (no swing is assumed across missing data); out-of-order frames are
// ignored. Inputs are never modified.
type FluctuationDetector struct {
	cfg    FluctuationConfig
	axes   []input.Axis
	state  map[input.Axis]*swing
	seen   bool
	lastMs float64
}

// NewFluctuationDetector tracks the selected controls only.
func NewFluctuationDetector(controls []input.Axis, cfg FluctuationConfig) *FluctuationDetector {
	d := &FluctuationDetector{cfg: cfg, axes: controls, state: map[input.Axis]*swing{}}
	for _, a := range controls {
		d.state[a] = &swing{}
	}
	return d
}

// Observe processes one frame and returns the onsets it produced (at most
// one per axis).
func (d *FluctuationDetector) Observe(f input.Frame) []FluctuationEvent {
	t := f.ReceivedMonoMs
	if d.seen && t < d.lastMs {
		return nil
	}
	d.seen, d.lastMs = true, t
	th := d.cfg.Amplitude + d.cfg.NoiseFloor
	var out []FluctuationEvent
	for _, a := range d.axes {
		s := d.state[a]
		v, ok := value(f, a)
		if !ok {
			*s = swing{alerting: s.alerting, lastRev: s.lastRev}
			continue
		}
		if s.alerting && t-s.lastRev > d.cfg.WindowMs {
			s.alerting = false // quiet long enough: re-arm
		}
		if !s.seen {
			s.seen, s.ext = true, v
			continue
		}
		switch {
		case s.dir == 0 && v-s.ext >= th:
			s.dir, s.ext = 1, v // first swing sets the direction
		case s.dir == 0 && s.ext-v >= th:
			s.dir, s.ext = -1, v
		case s.dir == 0:
		case float64(s.dir)*(v-s.ext) > 0:
			s.ext = v // extend the current swing
		case float64(s.dir)*(s.ext-v) >= th:
			s.dir, s.ext, s.lastRev = -s.dir, v, t
			s.revs = append(s.revs, t)
		}
		for len(s.revs) > 0 && t-s.revs[0] > d.cfg.WindowMs {
			s.revs = s.revs[1:]
		}
		if !s.alerting && len(s.revs) >= d.cfg.MinReversals {
			s.alerting = true
			out = append(out, FluctuationEvent{AtMs: t, Axis: a})
		}
	}
	return out
}
