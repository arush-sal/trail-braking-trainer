package engine

import (
	"math"
	"reflect"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/input"
)

func fluctuations(controls []input.Axis, cfg FluctuationConfig, fs []input.Frame) []FluctuationEvent {
	d := NewFluctuationDetector(controls, cfg)
	out := []FluctuationEvent{}
	for _, f := range fs {
		out = append(out, d.Observe(f)...)
	}
	return out
}

// then concatenates traces, shifting b to start stepMs after a ends.
func then(a, b []input.Frame) []input.Frame {
	off := a[len(a)-1].ReceivedMonoMs + stepMs
	out := append([]input.Frame(nil), a...)
	for _, f := range b {
		f.ReceivedMonoMs += off
		out = append(out, f)
	}
	return out
}

func TestFluctuationDetector(t *testing.T) {
	def := DefaultFluctuationConfig() // swing 0.03 + noise floor 0.005, 3 reversals in 1000 ms
	noisy := def
	noisy.NoiseFloor = 0.03
	wobble := wobbleHold(2000, 0.4, 0.05, 200) // +/-5% at 5 Hz on a 40% hold
	tests := []struct {
		name     string
		controls []input.Axis
		cfg      FluctuationConfig
		fs       []input.Frame
		want     []FluctuationEvent
	}{
		{"wobble on hold: one alert per episode", []input.Axis{B}, def, wobble, []FluctuationEvent{{AtMs: 300, Axis: B}}},
		{"re-arms after a quiet window", []input.Axis{B}, def,
			then(then(wobble, offsetHold(1500, 0.4, 0)), wobbleHold(1000, 0.4, 0.05, 200)),
			[]FluctuationEvent{{AtMs: 300, Axis: B}, {AtMs: 3820, Axis: B}}},
		{"short pause in the wobble does not re-alert", []input.Axis{B}, def,
			then(then(wobble, offsetHold(500, 0.4, 0)), wobbleHold(1000, 0.4, 0.05, 200)),
			[]FluctuationEvent{{AtMs: 300, Axis: B}}},
		{"smooth fast full sweep", []input.Axis{B}, def, smoothMove(2000, 0, 1, 50), []FluctuationEvent{}},
		{"fast sweep up then down (one reversal)", []input.Axis{B}, def,
			then(smoothMove(300, 0, 1, 100), smoothMove(300, 1, 0, 100)), []FluctuationEvent{}},
		{"slow smooth motion", []input.Axis{B}, def, smoothMove(4000, 0, 0.6, 3000), []FluctuationEvent{}},
		{"sensor noise below amplitude", []input.Axis{B}, def, withNoise(offsetHold(3000, 0.4, 0), 0.01, 3), []FluctuationEvent{}},
		{"noise floor raises the amplitude", []input.Axis{B}, noisy, withNoise(offsetHold(3000, 0.4, 0), 0.025, 3), []FluctuationEvent{}},
		{"unselected control ignored", []input.Axis{T}, def, wobble, []FluctuationEvent{}},
		{"unavailable channel never alerts", []input.Axis{S}, def, steeringMissing(wobble), []FluctuationEvent{}},
		{"gap frames reset the swing history", []input.Axis{B}, def, markGap(markGap(wobble, 140), 240), []FluctuationEvent{{AtMs: 600, Axis: B}}},
		// Only every other frame survives, so the first direction is set later.
		{"out-of-order frames ignored", []input.Axis{B}, def, outOfOrder(wobble), []FluctuationEvent{{AtMs: 410, Axis: B}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := fluctuations(tc.controls, tc.cfg, tc.fs); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestFluctuationPerAxis(t *testing.T) {
	// Steering wobbles while brake holds: only steering alerts.
	fs := trace(1000, func(t float64) (float64, float64, float64) {
		return 0.5, 0.05 * math.Sin(2*math.Pi*t/200), 0
	})
	want := []FluctuationEvent{{AtMs: 300, Axis: S}}
	if got := fluctuations([]input.Axis{B, S, T}, DefaultFluctuationConfig(), fs); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestProvisionalNoiseFloorDefaults(t *testing.T) {
	if o, f := DefaultOverlapConfig().NoiseFloor, DefaultFluctuationConfig().NoiseFloor; o != 0.005 || f != 0.005 {
		t.Fatalf("overlap %v fluctuation %v, want provisional 0.005", o, f)
	}
}
