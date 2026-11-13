package drills

import (
	"math"
	"testing"
)

func TestEase(t *testing.T) {
	tests := []struct {
		curve     Curve
		intensity float64
		u, want   float64
	}{
		{Linear, 3, 0.25, 0.25},
		{"", 0, 0.25, 0.25}, // empty curve = linear
		{EaseIn, 1, 0.5, 0.25},
		{EaseIn, 2, 0.5, 0.125},
		{EaseOut, 1, 0.5, 0.75},
		{EaseOut, 0, 0.3, 0.3}, // intensity 0 degenerates to linear
		{EaseInOut, 1, 0.25, 0.125},
		{EaseInOut, 1, 0.5, 0.5},
		{EaseInOut, 1, 0.75, 0.875},
		{EaseIn, 1, -1, 0}, // clamped
		{EaseOut, 1, 2, 1},
	}
	for _, tc := range tests {
		if got := Ease(tc.curve, tc.intensity, tc.u); math.Abs(got-tc.want) > 1e-12 {
			t.Errorf("Ease(%q,%v,%v)=%v want %v", tc.curve, tc.intensity, tc.u, got, tc.want)
		}
	}
}

// Every curve maps [0,1] onto [0,1], hits both endpoints exactly and is
// monotone non-decreasing, so a ramp never overshoots its From/To range.
func FuzzEaseMonotone(f *testing.F) {
	f.Add(uint8(0), 1.0, 0.2, 0.7)
	f.Add(uint8(3), 4.0, 0.49, 0.51)
	f.Fuzz(func(t *testing.T, c uint8, intensity, a, b float64) {
		curve := []Curve{Linear, EaseIn, EaseOut, EaseInOut}[int(c)%4]
		if !(intensity >= 0 && intensity <= MaxIntensity) || !(a >= 0 && a <= 1) || !(b >= 0 && b <= 1) {
			t.Skip()
		}
		if a > b {
			a, b = b, a
		}
		if Ease(curve, intensity, 0) != 0 || Ease(curve, intensity, 1) != 1 {
			t.Fatalf("%s endpoints not exact", curve)
		}
		ya, yb := Ease(curve, intensity, a), Ease(curve, intensity, b)
		if ya < 0 || yb > 1 || ya > yb {
			t.Fatalf("%s(%v) not monotone in range: f(%v)=%v f(%v)=%v", curve, intensity, a, ya, b, yb)
		}
	})
}
