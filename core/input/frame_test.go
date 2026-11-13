package input

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func ptr(f float64) *float64 { return &f }

func avail(v float64) Measurement {
	return Measurement{Available: true, RawValue: ptr(v), RawUnit: "ratio", Normalized: ptr(v)}
}

func validFrame() Frame {
	return Frame{
		SchemaVersion:  1,
		Source:         SourceMock,
		SourceID:       "mock-0",
		ReceivedMonoMs: 10,
		Brake:          avail(0.5),
		Steering:       avail(-0.25),
		Throttle:       Measurement{RawUnit: "ratio"},
	}
}

func TestValidate(t *testing.T) {
	nan, inf := math.NaN(), math.Inf(1)
	tests := []struct {
		name    string
		mut     func(*Frame)
		wantErr string // empty = valid
	}{
		{"valid", func(*Frame) {}, ""},
		{"bad schema", func(f *Frame) { f.SchemaVersion = 2 }, "schemaVersion"},
		{"bad source", func(f *Frame) { f.Source = "x" }, "source"},
		{"empty sourceId", func(f *Frame) { f.SourceID = "" }, "sourceId"},
		{"negative time", func(f *Frame) { f.ReceivedMonoMs = -1 }, "receivedMonoMs"},
		{"NaN time", func(f *Frame) { f.ReceivedMonoMs = nan }, "receivedMonoMs"},
		{"Inf time", func(f *Frame) { f.ReceivedMonoMs = inf }, "receivedMonoMs"},
		{"brake >1", func(f *Frame) { f.Brake = avail(1.1) }, "brake.normalized"},
		{"brake <0", func(f *Frame) { f.Brake = avail(-0.1) }, "brake.normalized"},
		{"throttle >1", func(f *Frame) { f.Throttle = avail(2) }, "throttle.normalized"},
		{"steering -1 ok", func(f *Frame) { f.Steering = avail(-1) }, ""},
		{"steering >1", func(f *Frame) { f.Steering = avail(1.5) }, "steering.normalized"},
		{"steering <-1", func(f *Frame) { f.Steering = avail(-1.5) }, "steering.normalized"},
		{"NaN normalized", func(f *Frame) { f.Brake.Normalized = ptr(nan) }, "brake.normalized"},
		{"Inf normalized", func(f *Frame) { f.Brake.Normalized = ptr(inf) }, "brake.normalized"},
		{"NaN raw", func(f *Frame) { f.Brake.RawValue = ptr(nan) }, "brake.rawValue"},
		{"Inf raw", func(f *Frame) { f.Steering.RawValue = ptr(inf) }, "steering.rawValue"},
		{"available no normalized", func(f *Frame) { f.Brake.Normalized = nil }, "brake.normalized"},
		{"available no raw", func(f *Frame) { f.Brake.RawValue = nil }, "brake.rawValue"},
		{"unavailable with normalized", func(f *Frame) { f.Throttle.Normalized = ptr(0) }, "throttle.normalized"},
		{"unavailable with raw", func(f *Frame) { f.Throttle.RawValue = ptr(0) }, "throttle.rawValue"},
		{"NaN sourceTimestamp", func(f *Frame) { f.SourceTimestampMs = ptr(nan) }, "sourceTimestampMs"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := validFrame()
			tc.mut(&f)
			err := f.Validate()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want error naming %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestJSONRoundTrip(t *testing.T) {
	f := validFrame()
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"schemaVersion", "source", "sourceId", "receivedMonoMs", "brake", "steering", "throttle", "quality"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing key %q", k)
		}
	}
	for _, k := range []string{"sequence", "sourceTimestampMs"} {
		if _, ok := m[k]; ok {
			t.Errorf("optional key %q should be omitted", k)
		}
	}
	thr := m["throttle"].(map[string]any)
	for _, k := range []string{"rawValue", "normalized"} {
		if v, ok := thr[k]; !ok || v != nil {
			t.Errorf("throttle.%s should be explicit null, got %v (present=%v)", k, v, ok)
		}
	}
	if _, ok := thr["calibrationId"]; ok {
		t.Error("calibrationId should be omitted when empty")
	}
	if q := m["quality"].(map[string]any); len(q) != 3 {
		t.Errorf("quality keys: %v", q)
	}

	var back Frame
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if err := back.Validate(); err != nil {
		t.Fatalf("round-tripped frame invalid: %v", err)
	}
	if back.Throttle.Normalized != nil || *back.Brake.Normalized != 0.5 {
		t.Error("round trip changed values")
	}
}
