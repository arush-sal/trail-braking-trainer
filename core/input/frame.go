// Package input mirrors the InputFrame contract (spec 4.1).
package input

import (
	"fmt"
	"math"
)

// Axis names a measured channel.
type Axis string

// Axes.
const (
	AxisBrake    Axis = "brake"
	AxisSteering Axis = "steering"
	AxisThrottle Axis = "throttle"
)

// Source identifies where a frame came from.
type Source string

// Sources.
const (
	SourceGamepad Source = "gamepad"
	SourceGT7     Source = "gt7"
	SourceMock    Source = "mock"
)

// Measurement is one axis sample. Missing values stay nil, never zero.
type Measurement struct {
	Available     bool     `json:"available"`
	RawValue      *float64 `json:"rawValue"`
	RawUnit       string   `json:"rawUnit"`
	Normalized    *float64 `json:"normalized"`
	CalibrationID string   `json:"calibrationId,omitempty"`
}

// Quality flags describe sample health.
type Quality struct {
	Gap        bool `json:"gap"`
	Stale      bool `json:"stale"`
	Calibrated bool `json:"calibrated"`
}

// Frame is the source-independent input frame.
type Frame struct {
	SchemaVersion     int         `json:"schemaVersion"`
	Source            Source      `json:"source"`
	SourceID          string      `json:"sourceId"`
	Sequence          *uint64     `json:"sequence,omitempty"`
	ReceivedMonoMs    float64     `json:"receivedMonoMs"`
	SourceTimestampMs *float64    `json:"sourceTimestampMs,omitempty"`
	Brake             Measurement `json:"brake"`
	Steering          Measurement `json:"steering"`
	Throttle          Measurement `json:"throttle"`
	Quality           Quality     `json:"quality"`
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// Validate checks the frame against the contract; errors name the field.
func (f Frame) Validate() error {
	if f.SchemaVersion != 1 {
		return fmt.Errorf("schemaVersion: must be 1, got %d", f.SchemaVersion)
	}
	switch f.Source {
	case SourceGamepad, SourceGT7, SourceMock:
	default:
		return fmt.Errorf("source: unknown %q", f.Source)
	}
	if f.SourceID == "" {
		return fmt.Errorf("sourceId: must not be empty")
	}
	if !finite(f.ReceivedMonoMs) || f.ReceivedMonoMs < 0 {
		return fmt.Errorf("receivedMonoMs: must be finite and >= 0, got %v", f.ReceivedMonoMs)
	}
	if f.SourceTimestampMs != nil && !finite(*f.SourceTimestampMs) {
		return fmt.Errorf("sourceTimestampMs: must be finite, got %v", *f.SourceTimestampMs)
	}
	// Steering's signed [-1,1] practice scale is provisional: units are
	// unresolved until hardware validation (spec 4.1).
	for _, a := range []struct {
		axis     Axis
		m        Measurement
		min, max float64
	}{
		{AxisBrake, f.Brake, 0, 1},
		{AxisSteering, f.Steering, -1, 1},
		{AxisThrottle, f.Throttle, 0, 1},
	} {
		if err := a.m.validate(a.axis, a.min, a.max); err != nil {
			return err
		}
	}
	return nil
}

func (m Measurement) validate(axis Axis, lo, hi float64) error {
	if !m.Available {
		if m.RawValue != nil {
			return fmt.Errorf("%s.rawValue: must be null when unavailable", axis)
		}
		if m.Normalized != nil {
			return fmt.Errorf("%s.normalized: must be null when unavailable", axis)
		}
		return nil
	}
	if m.RawValue == nil || !finite(*m.RawValue) {
		return fmt.Errorf("%s.rawValue: must be a finite number when available", axis)
	}
	if m.Normalized == nil || !finite(*m.Normalized) {
		return fmt.Errorf("%s.normalized: must be a finite number when available", axis)
	}
	if n := *m.Normalized; n < lo || n > hi {
		return fmt.Errorf("%s.normalized: %v outside [%v,%v]", axis, n, lo, hi)
	}
	return nil
}
