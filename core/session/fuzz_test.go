package session

import (
	"slices"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/input"
)

// FuzzSession drives random op/time sequences and checks invariants:
// only table transitions, never panics, time monotonic, consistent accounting.
func FuzzSession(f *testing.F) {
	f.Add([]byte{0, 0, 1, 50, 2, 9, 3, 200, 4, 7, 5, 1, 6, 80, 7, 3, 8, 255, 9, 1})
	f.Add([]byte{0, 0, 8, 255, 8, 255, 8, 255, 8, 255})
	f.Fuzz(func(t *testing.T, ops []byte) {
		sp := len(ops) > 0 && ops[0]%2 == 1
		var c Config
		if sp {
			c = selfPacedCfg(CompletionEither, func(f input.Frame) bool { return *f.Brake.Normalized > 0.9 })
		} else {
			c = timedCfg()
			c.RoundDurationMs = 700
		}
		c.Rounds = 3
		c.RestMs, c.CountdownMs = 300, 1500
		c.MaxSamplesPerRound = 4
		c.RequiredAxes = []input.Axis{input.AxisBrake}
		c.MaxAttemptsPerRound = 2
		c = withSilenceRule(c)
		s := mustNew(t, c)
		now, lastEv := 0.0, 0.0
		cmds := []Command{CmdStart, CmdPause, CmdResume, CmdCompleteRound, CmdSkipRound, CmdStop}
		for i := 0; i+1 < len(ops); i += 2 {
			op, arg := ops[i]%11, ops[i+1]
			dt := float64(arg) * 10
			if arg == 255 {
				dt = -5 // occasional non-monotonic time
			}
			before := snapshot(s)
			prevNow := s.now
			var evs []Event
			var err error
			switch {
			case op < 6:
				evs, err = s.Dispatch(cmds[op], now+dt)
			case op == 6:
				fr := frame(now+dt, float64(arg)/255)
				fr.Quality.Gap = arg%17 == 0
				evs, err = s.Observe(fr)
			case op == 7:
				evs, err = s.SourceLost(now + dt)
			case op == 8:
				evs, err = s.Tick(now + dt)
			case op == 9:
				evs, err = s.SourceRestored(now + dt)
			default:
				if arg%31 == 0 {
					s.Reset()
					_ = s.Configure(c)
					now, lastEv = 0, 0
					continue
				}
				evs, err = s.Tick(now + dt)
			}
			if err != nil {
				if got := snapshot(s); !snapEqual(got, before) || s.now != prevNow || evs != nil {
					t.Fatalf("op %d errored but changed state: %v", op, err)
				}
			} else if now+dt > now {
				now += dt
			}
			if s.now < prevNow {
				t.Fatal("clock went backwards")
			}
			for _, e := range evs {
				if e.AtMs < lastEv || e.AtMs > s.now {
					t.Fatalf("event time %v outside [%v,%v]", e.AtMs, lastEv, s.now)
				}
				lastEv = e.AtMs
				if e.Kind == EvStateChanged && !slices.Contains(Transitions[e.From], e.To) {
					t.Fatalf("illegal transition %s -> %s", e.From, e.To)
				}
			}
			checkInvariants(t, s)
		}
	})
}

type snap struct {
	state    State
	done, na int
}

func snapshot(s *Session) snap { return snap{s.state, s.done, len(s.attempts)} }

func snapEqual(a, b snap) bool { return a == b }

func checkInvariants(t *testing.T, s *Session) {
	t.Helper()
	if _, ok := Transitions[s.state]; !ok {
		t.Fatalf("unknown state %q", s.state)
	}
	if s.state == Idle {
		return
	}
	if len(s.attempts) > s.cfg.Rounds*s.cfg.MaxAttemptsPerRound {
		t.Fatalf("%d attempts exceed rounds*cap", len(s.attempts))
	}
	done, invalid := 0, map[int]int{}
	for _, a := range s.attempts {
		switch a.Outcome {
		case OutcomeCompletedTimed, OutcomeCompletedAuto, OutcomeCompletedManual, OutcomeSkipped:
			done++
		case OutcomeInvalidSourceLost:
			if invalid[a.Round]++; invalid[a.Round] == s.cfg.MaxAttemptsPerRound {
				done++ // round used up by the cap
			}
		case OutcomeAborted:
		default:
			t.Fatalf("bad outcome %q", a.Outcome)
		}
		if len(a.Paused) > MaxPausedIntervals || (a.PausedTruncated && len(a.Paused) != MaxPausedIntervals) {
			t.Fatalf("paused intervals unbounded: %d", len(a.Paused))
		}
		if a.EndMs < a.StartMs || len(a.Frames) > s.cfg.MaxSamplesPerRound || (a.Truncated && len(a.Frames) != s.cfg.MaxSamplesPerRound) {
			t.Fatalf("bad attempt %+v", a)
		}
		if a.Outcome == OutcomeCompletedTimed && !a.Truncated {
			if h := coverageHole(a); h > s.cfg.MaxFrameGapMs {
				t.Fatalf("completedTimed with a %v ms unpaused frame hole", h)
			}
		}
		if a.Round < 1 || a.Round > s.cfg.Rounds {
			t.Fatalf("round %d out of range", a.Round)
		}
	}
	if s.invalids >= s.cfg.MaxAttemptsPerRound {
		done-- // cap reached, round consumed on SourceRestored
	}
	if done != s.done || s.done > s.cfg.Rounds {
		t.Fatalf("accounting: counted %d, done %d, rounds %d", done, s.done, s.cfg.Rounds)
	}
	if (s.state == Complete) != (s.done == s.cfg.Rounds) {
		t.Fatalf("state %s with %d/%d done", s.state, s.done, s.cfg.Rounds)
	}
}

// coverageHole is the largest unpaused stretch of a finished attempt without
// a frame, counting from its start to its end.
func coverageHole(a Attempt) float64 {
	pts := []float64{a.StartMs}
	for _, f := range a.Frames {
		pts = append(pts, f.ReceivedMonoMs)
	}
	pts = append(pts, a.EndMs)
	worst := 0.0
	for i := 1; i < len(pts); i++ {
		h := pts[i] - pts[i-1]
		for _, p := range a.Paused {
			h -= max(0, min(p.EndMs, pts[i])-max(p.StartMs, pts[i-1]))
		}
		worst = max(worst, h)
	}
	return worst
}
