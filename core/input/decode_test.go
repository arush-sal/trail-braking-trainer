package input

import (
	"encoding/json"
	"strings"
	"testing"
)

const validJSON = `{"schemaVersion":1,"source":"mock","sourceId":"m","sequence":3,"receivedMonoMs":5,
"brake":{"available":true,"rawValue":0.5,"rawUnit":"r","normalized":0.5},
"steering":{"available":false,"rawValue":null,"rawUnit":"none","normalized":null},
"throttle":{"available":true,"rawValue":0,"rawUnit":"r","normalized":0},
"quality":{"gap":false,"stale":false,"calibrated":false}}`

func mutate(t *testing.T, f func(m map[string]any)) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(validJSON), &m); err != nil {
		t.Fatal(err)
	}
	f(m)
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func sub(m map[string]any, k string) map[string]any { return m[k].(map[string]any) }

func TestDecode(t *testing.T) {
	if _, err := Decode([]byte(validJSON)); err != nil {
		t.Fatalf("valid frame rejected: %v", err)
	}
	tests := []struct {
		name, want string
		mut        func(map[string]any)
	}{
		{"missing receivedMonoMs", "receivedMonoMs", func(m map[string]any) { delete(m, "receivedMonoMs") }},
		{"missing brake", "brake", func(m map[string]any) { delete(m, "brake") }},
		{"missing quality", "quality", func(m map[string]any) { delete(m, "quality") }},
		{"missing quality.gap", "quality.gap", func(m map[string]any) { delete(sub(m, "quality"), "gap") }},
		{"missing brake.normalized", "brake.normalized", func(m map[string]any) { delete(sub(m, "brake"), "normalized") }},
		{"missing steering.available", "steering.available", func(m map[string]any) { delete(sub(m, "steering"), "available") }},
		{"null sequence", "sequence", func(m map[string]any) { m["sequence"] = nil }},
		{"null sourceTimestampMs", "sourceTimestampMs", func(m map[string]any) { m["sourceTimestampMs"] = nil }},
		{"null calibrationId", "brake.calibrationId", func(m map[string]any) { sub(m, "brake")["calibrationId"] = nil }},
		{"null schemaVersion", "schemaVersion", func(m map[string]any) { m["schemaVersion"] = nil }},
		{"unknown field", "unknown", func(m map[string]any) { m["extra"] = 1 }},
		{"semantic invalid", "brake.normalized", func(m map[string]any) { sub(m, "brake")["normalized"] = 2 }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Decode(mutate(t, tc.mut))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %v", tc.want, err)
			}
		})
	}
	if _, err := Decode([]byte(`{`)); err == nil {
		t.Fatal("malformed JSON accepted")
	}
}
