package session

import (
	"errors"
	"fmt"
	"math"

	"github.com/arush-sal/trail-braking-trainer/core/input"
)

// TimingMode selects how a round ends (spec 3.4, R-016).
type TimingMode string

// Timing modes.
const (
	TimingTimed     TimingMode = "timed"
	TimingSelfPaced TimingMode = "selfPaced"
)

// CompletionMode selects how a self-paced round completes (spec 3.5, R-017).
type CompletionMode string

// Completion modes.
const (
	CompletionAuto   CompletionMode = "auto"
	CompletionManual CompletionMode = "manual"
	CompletionEither CompletionMode = "either"
)

// Completion detects a valid terminal state for self-paced auto/either
// (engine.CompletionDetector satisfies it). The session calls Reset at the
// start of every attempt, on pause, on resume and on source loss, so hold
// state never leaks across rounds or pauses. It sees only ACTIVE frames.
type Completion interface {
	Observe(f input.Frame) bool
	Reset()
}

// Validation limits.
const (
	MaxRounds           = 100
	MaxDurationMs       = 3_600_000 // 1 h cap for any rest/countdown/round duration
	MaxSamplesPerRound  = 216_000   // 1 h at 60 Hz
	MaxAttemptsPerRound = 10
)

// Config configures one session. Durations are monotonic milliseconds.
type Config struct {
	Rounds          int            `json:"rounds"`
	RestMs          float64        `json:"restMs"`
	CountdownMs     float64        `json:"countdownMs"`
	Timing          TimingMode     `json:"timing"`
	RoundDurationMs float64        `json:"roundDurationMs,omitempty"` // timed only
	Completion      CompletionMode `json:"completion,omitempty"`      // selfPaced only
	// RequiredAxes: an ACTIVE frame with any of these unavailable is a source loss.
	RequiredAxes       []input.Axis `json:"requiredAxes,omitempty"`
	MaxSamplesPerRound int          `json:"maxSamplesPerRound"`
	// MaxAttemptsPerRound caps invalidSourceLost attempts per round; at the
	// cap the round is used up (neither completed nor skipped).
	MaxAttemptsPerRound int `json:"maxAttemptsPerRound"`
	// AutoComplete is required for self-paced auto/either.
	AutoComplete Completion `json:"-"`
}

// DefaultConfig returns the proposed defaults: 8 rounds (R-019), 5 s rest and
// 3 s countdown (spec 3.5, proposed), timed 10 s rounds (placeholder; drills
// supply real durations), 18000 samples per round (5 min at 60 Hz), and 3
// attempts per round.
func DefaultConfig() Config {
	return Config{
		Rounds:              8,
		RestMs:              5000,
		CountdownMs:         3000,
		Timing:              TimingTimed,
		RoundDurationMs:     10000,
		MaxSamplesPerRound:  18000,
		MaxAttemptsPerRound: 3,
	}
}

func checkDuration(name string, v float64, allowZero bool) error {
	if math.IsNaN(v) || v < 0 || v > MaxDurationMs || (!allowZero && v == 0) {
		return fmt.Errorf("%s: must be in (0,%d] ms (0 allowed: %v), got %v", name, MaxDurationMs, allowZero, v)
	}
	return nil
}

// Validate rejects out-of-range values and illegal mode combinations.
func (c Config) Validate() error {
	if c.Rounds < 1 || c.Rounds > MaxRounds {
		return fmt.Errorf("rounds: must be in [1,%d], got %d", MaxRounds, c.Rounds)
	}
	if err := checkDuration("restMs", c.RestMs, true); err != nil {
		return err
	}
	if err := checkDuration("countdownMs", c.CountdownMs, true); err != nil {
		return err
	}
	switch c.Timing {
	case TimingTimed:
		if err := checkDuration("roundDurationMs", c.RoundDurationMs, false); err != nil {
			return err
		}
		if c.Completion != "" {
			return errors.New("completion: only for selfPaced timing")
		}
	case TimingSelfPaced:
		if c.RoundDurationMs != 0 {
			return errors.New("roundDurationMs: only for timed timing")
		}
		switch c.Completion {
		case CompletionManual:
		case CompletionAuto, CompletionEither:
			if c.AutoComplete == nil {
				return fmt.Errorf("completion %q: requires an AutoComplete hook", c.Completion)
			}
		default:
			return fmt.Errorf("completion: must be auto, manual or either, got %q", c.Completion)
		}
	default:
		return fmt.Errorf("timing: must be timed or selfPaced, got %q", c.Timing)
	}
	for _, a := range c.RequiredAxes {
		switch a {
		case input.AxisBrake, input.AxisSteering, input.AxisThrottle:
		default:
			return fmt.Errorf("requiredAxes: unknown axis %q", a)
		}
	}
	if c.MaxSamplesPerRound < 1 || c.MaxSamplesPerRound > MaxSamplesPerRound {
		return fmt.Errorf("maxSamplesPerRound: must be in [1,%d], got %d", MaxSamplesPerRound, c.MaxSamplesPerRound)
	}
	if c.MaxAttemptsPerRound < 1 || c.MaxAttemptsPerRound > MaxAttemptsPerRound {
		return fmt.Errorf("maxAttemptsPerRound: must be in [1,%d], got %d", MaxAttemptsPerRound, c.MaxAttemptsPerRound)
	}
	return nil
}
