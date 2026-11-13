package engine

import (
	"math"
	"math/rand/v2"

	"github.com/arush-sal/trail-braking-trainer/core/drills"
	"github.com/arush-sal/trail-braking-trainer/core/input"
)

// Synthetic trace fixtures (spec 11.1). All traces are deterministic,
// sampled every stepMs, and built on the real input.Frame contract.

const stepMs = 10.0

// na marks a channel as unavailable (null), never zero.
var na = math.NaN()

const (
	B = input.AxisBrake
	S = input.AxisSteering
	T = input.AxisThrottle
)

func meas(v float64) input.Measurement {
	if math.IsNaN(v) {
		return input.Measurement{RawUnit: "none"}
	}
	return input.Measurement{Available: true, RawValue: &v, RawUnit: "ratio", Normalized: &v}
}

func frame(tMs, b, s, th float64) input.Frame {
	return input.Frame{
		SchemaVersion: 1, Source: input.SourceMock, SourceID: "fixture", ReceivedMonoMs: tMs,
		Brake: meas(b), Steering: meas(s), Throttle: meas(th),
	}
}

// trace samples fn at stepMs from 0 to durMs inclusive.
func trace(durMs float64, fn func(t float64) (b, s, th float64)) []input.Frame {
	var out []input.Frame
	for t := 0.0; t <= durMs; t += stepMs {
		b, s, th := fn(t)
		out = append(out, frame(t, b, s, th))
	}
	return out
}

// constant holds fixed values.
func constant(durMs, b, s, th float64) []input.Frame {
	return trace(durMs, func(float64) (float64, float64, float64) { return b, s, th })
}

// exactTarget replays a timed drill's desired values exactly.
func exactTarget(d drills.DrillDefinition, extraMs float64) []input.Frame {
	var total float64
	for _, p := range d.Phases {
		total += p.DurationMs
	}
	return trace(total+extraMs, func(t float64) (float64, float64, float64) {
		s, err := drills.TargetAt(d, t)
		if err != nil {
			panic(err)
		}
		get := func(a input.Axis) float64 {
			if v, ok := s.Values[a]; ok {
				return v
			}
			return 0
		}
		return get(B), get(S), get(T)
	})
}

// offsetHold / wobbleHold: brake held at v+offset, or v + amp*sin(2*pi*t/period).
func offsetHold(durMs, v, offset float64) []input.Frame { return constant(durMs, v+offset, 0, 0) }

func wobbleHold(durMs, v, amp, periodMs float64) []input.Frame {
	return trace(durMs, func(t float64) (float64, float64, float64) {
		return v + amp*math.Sin(2*math.Pi*t/periodMs), 0, 0
	})
}

// smoothMove ramps brake linearly from->to over moveMs, then holds to durMs.
// Short moveMs is deliberate fast motion; long moveMs is slow motion.
func smoothMove(durMs, from, to, moveMs float64) []input.Frame {
	return trace(durMs, func(t float64) (float64, float64, float64) {
		return from + (to-from)*math.Min(t/moveMs, 1), 0, 0
	})
}

// jerkyReversal: brake up to 0.6, snaps back to 0.2, up to 0.4, then holds.
func jerkyReversal() []input.Frame {
	return trace(1500, func(t float64) (float64, float64, float64) {
		switch {
		case t < 300:
			return 0.6 * t / 300, 0, 0
		case t < 350:
			return 0.6 - 0.4*(t-300)/50, 0, 0
		case t < 500:
			return 0.2 + 0.2*(t-350)/150, 0, 0
		default:
			return 0.4, 0, 0
		}
	})
}

// overlapTrace: brake 0.5 throughout; throttle 0 except th(t) inside [fromMs,toMs).
func overlapTrace(durMs, fromMs, toMs float64, th func(t float64) float64) []input.Frame {
	return trace(durMs, func(t float64) (float64, float64, float64) {
		if t >= fromMs && t < toMs {
			return 0.5, 0, th(t)
		}
		return 0.5, 0, 0
	})
}

// flap alternates between lo and hi every frame, i.e. chatter around a threshold.
func flap(lo, hi float64) func(float64) float64 {
	return func(t float64) float64 {
		if int(t/stepMs)%2 == 0 {
			return hi
		}
		return lo
	}
}

// withNoise adds deterministic uniform noise in [-amp,amp] to brake and
// throttle, clamped to [0,1].
func withNoise(fs []input.Frame, amp float64, seed uint64) []input.Frame {
	r := rand.New(rand.NewPCG(seed, seed)) //nolint:gosec // deterministic fixture noise
	out := make([]input.Frame, len(fs))
	for i, f := range fs {
		nb := func(m input.Measurement) input.Measurement {
			if !m.Available {
				return m
			}
			return meas(math.Min(math.Max(*m.Normalized+amp*(2*r.Float64()-1), 0), 1))
		}
		f.Brake, f.Throttle = nb(f.Brake), nb(f.Throttle)
		out[i] = f
	}
	return out
}

// dropFrames removes frames with fromMs <= t < toMs (silent dropout).
func dropFrames(fs []input.Frame, fromMs, toMs float64) []input.Frame {
	var out []input.Frame
	for _, f := range fs {
		if f.ReceivedMonoMs < fromMs || f.ReceivedMonoMs >= toMs {
			out = append(out, f)
		}
	}
	return out
}

// markGap flags the frame at atMs as a source gap.
func markGap(fs []input.Frame, atMs float64) []input.Frame {
	out := append([]input.Frame(nil), fs...)
	for i := range out {
		if out[i].ReceivedMonoMs == atMs {
			out[i].Quality.Gap = true
		}
	}
	return out
}

// outOfOrder swaps every adjacent pair of frames.
func outOfOrder(fs []input.Frame) []input.Frame {
	out := append([]input.Frame(nil), fs...)
	for i := 0; i+1 < len(out); i += 2 {
		out[i], out[i+1] = out[i+1], out[i]
	}
	return out
}

// steeringMissing marks steering unavailable on every frame.
func steeringMissing(fs []input.Frame) []input.Frame {
	out := append([]input.Frame(nil), fs...)
	for i := range out {
		out[i].Steering = meas(na)
	}
	return out
}
