package input

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Field presence rules for wire frames. Go zero values cannot tell "absent"
// from "0/false", so presence is checked before decoding (spec 4.1: never
// turn a missing value into zero).
var (
	frameRequired       = []string{"schemaVersion", "source", "sourceId", "receivedMonoMs", "brake", "steering", "throttle", "quality"}
	frameOptional       = []string{"sequence", "sourceTimestampMs"}
	measurementRequired = []string{"available", "rawUnit"}
	measurementNullable = []string{"rawValue", "normalized"} // must be present, may be null
	qualityRequired     = []string{"gap", "stale", "calibrated"}
)

// Decode parses a JSON InputFrame strictly and validates it.
func Decode(data []byte) (Frame, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return Frame{}, fmt.Errorf("invalid JSON: %w", err)
	}
	if err := checkFields("", top, frameRequired, nil, frameOptional); err != nil {
		return Frame{}, err
	}
	for _, axis := range []string{"brake", "steering", "throttle"} {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(top[axis], &m); err != nil {
			return Frame{}, fmt.Errorf("%s: must be an object", axis)
		}
		if err := checkFields(axis+".", m, measurementRequired, measurementNullable, []string{"calibrationId"}); err != nil {
			return Frame{}, err
		}
	}
	var q map[string]json.RawMessage
	if err := json.Unmarshal(top["quality"], &q); err != nil {
		return Frame{}, fmt.Errorf("quality: must be an object")
	}
	if err := checkFields("quality.", q, qualityRequired, nil, nil); err != nil {
		return Frame{}, err
	}

	var f Frame
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return Frame{}, fmt.Errorf("invalid frame: %w", err)
	}
	return f, f.Validate()
}

func isNull(v json.RawMessage) bool { return string(bytes.TrimSpace(v)) == "null" }

// checkFields: required = present and non-null; nullable = present;
// optional = may be absent but never null.
func checkFields(prefix string, m map[string]json.RawMessage, required, nullable, optional []string) error {
	for _, k := range required {
		v, ok := m[k]
		if !ok || isNull(v) {
			return fmt.Errorf("%s%s: required", prefix, k)
		}
	}
	for _, k := range nullable {
		if _, ok := m[k]; !ok {
			return fmt.Errorf("%s%s: required (use null when unavailable)", prefix, k)
		}
	}
	for _, k := range optional {
		if v, ok := m[k]; ok && isNull(v) {
			return fmt.Errorf("%s%s: must be omitted, not null", prefix, k)
		}
	}
	return nil
}
