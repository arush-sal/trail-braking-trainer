package drills

import "math"

// Curve names a ramp profile. Every curve f maps progress u in [0,1] onto
// [0,1] with f(0)=0, f(1)=1 and f monotone non-decreasing, so an eased ramp
// From->To never leaves the [From,To] range. A ramp's value at local progress
// u is From + (To-From)*f(u).
type Curve string

// Curves (spec 3.3). With p = 1 + intensity:
const (
	// Linear: f(u) = u. Intensity is ignored.
	Linear Curve = "linear"
	// EaseIn, "gentle start / fast finish": f(u) = u^p.
	EaseIn Curve = "easeIn"
	// EaseOut, "fast start / gentle finish": f(u) = 1 - (1-u)^p.
	EaseOut Curve = "easeOut"
	// EaseInOut, "smooth start and finish":
	// f(u) = 2^(p-1) * u^p             for u < 1/2,
	// f(u) = 1 - 2^(p-1) * (1-u)^p     for u >= 1/2.
	// Both halves meet at f(1/2) = 1/2.
	EaseInOut Curve = "easeInOut"
)

// MaxIntensity bounds the intensity parameter: intensity is in
// [0, MaxIntensity], so the exponent p = 1 + intensity is in [1, 5].
// Intensity 0 makes every curve linear; 1 (quadratic) is the preset default.
// The upper bound is a PROPOSED limit (R-022), not a validated threshold.
const MaxIntensity = 4.0

// Ease evaluates curve c at progress u (clamped to [0,1]). An empty curve is
// Linear. Unknown curves also evaluate as Linear; Validate rejects them.
func Ease(c Curve, intensity, u float64) float64 {
	u = math.Min(math.Max(u, 0), 1)
	p := 1 + intensity
	switch c {
	case EaseIn:
		return math.Pow(u, p)
	case EaseOut:
		return 1 - math.Pow(1-u, p)
	case EaseInOut:
		if u < 0.5 {
			return math.Pow(2, p-1) * math.Pow(u, p)
		}
		return 1 - math.Pow(2, p-1)*math.Pow(1-u, p)
	default:
		return u
	}
}
