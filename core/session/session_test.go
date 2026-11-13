package session

import (
	"errors"
	"math"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/drills"
	"github.com/arush-sal/trail-braking-trainer/core/engine"
	"github.com/arush-sal/trail-braking-trainer/core/input"
)

// The real engine detector is a session Completion.
var _ Completion = (*engine.CompletionDetector)(nil)

func ptr(v float64) *float64 { return &v }

func meas(v float64) input.Measurement {
	return input.Measurement{Available: true, RawValue: ptr(v), RawUnit: "ratio", Normalized: ptr(v)}
}

// frame returns a valid frame with all axes available at time t.
func frame(t, brake float64) input.Frame {
	return input.Frame{
		SchemaVersion: 1, Source: input.SourceMock, SourceID: "m", ReceivedMonoMs: t,
		Brake: meas(brake), Steering: meas(0), Throttle: meas(0),
	}
}

func timedCfg() Config {
	c := DefaultConfig()
	c.RoundDurationMs = 10000
	return c
}

func selfPacedCfg(mode CompletionMode, hook func(input.Frame) bool) Config {
	c := DefaultConfig()
	c.Timing = TimingSelfPaced
	c.RoundDurationMs = 0
	c.Completion = mode
	if hook != nil {
		c.AutoComplete = funcHook(hook)
	}
	return c
}

// funcHook adapts a stateless func to Completion (Reset is a no-op).
type funcHook func(input.Frame) bool

func (h funcHook) Observe(f input.Frame) bool { return h(f) }
func (funcHook) Reset()                       {}

func mustNew(t *testing.T, c Config) *Session {
	t.Helper()
	s := New()
	if err := s.Configure(c); err != nil {
		t.Fatalf("configure: %v", err)
	}
	return s
}

// must panics on error (Go cannot pass t alongside a multi-value call);
// the test still fails with a stack trace.
func must(evs []Event, err error) []Event {
	if err != nil {
		panic(err)
	}
	return evs
}

func wantState(t *testing.T, s *Session, want State) {
	t.Helper()
	if s.State() != want {
		t.Fatalf("state = %s, want %s", s.State(), want)
	}
}

func count(evs []Event, k EventKind) int {
	n := 0
	for _, e := range evs {
		if e.Kind == k {
			n++
		}
	}
	return n
}

func TestDefaultConfig(t *testing.T) {
	c := DefaultConfig()
	if c.Rounds != 8 || c.RestMs != 5000 || c.CountdownMs != 3000 || c.Timing != TimingTimed || c.MaxAttemptsPerRound != 3 {
		t.Fatalf("defaults: %+v", c)
	}
	if err := c.Validate(); err != nil {
		t.Fatalf("default config invalid: %v", err)
	}
}

func TestConfigValidate(t *testing.T) {
	hook := func(input.Frame) bool { return false }
	tests := []struct {
		name string
		mut  func(*Config)
		ok   bool
	}{
		{"default", func(*Config) {}, true},
		{"zero rounds", func(c *Config) { c.Rounds = 0 }, false},
		{"too many rounds", func(c *Config) { c.Rounds = MaxRounds + 1 }, false},
		{"max rounds", func(c *Config) { c.Rounds = MaxRounds }, true},
		{"negative rest", func(c *Config) { c.RestMs = -1 }, false},
		{"NaN countdown", func(c *Config) { c.CountdownMs = math.NaN() }, false},
		{"zero rest+countdown ok", func(c *Config) { c.RestMs, c.CountdownMs = 0, 0 }, true},
		{"huge rest", func(c *Config) { c.RestMs = MaxDurationMs + 1 }, false},
		{"timed zero duration", func(c *Config) { c.RoundDurationMs = 0 }, false},
		{"timed Inf duration", func(c *Config) { c.RoundDurationMs = math.Inf(1) }, false},
		{"timed with completion", func(c *Config) { c.Completion = CompletionManual }, false},
		{"bad timing", func(c *Config) { c.Timing = "x" }, false},
		{"selfPaced manual", func(c *Config) { *c = selfPacedCfg(CompletionManual, nil) }, true},
		{"selfPaced auto no hook", func(c *Config) { *c = selfPacedCfg(CompletionAuto, nil) }, false},
		{"selfPaced either no hook", func(c *Config) { *c = selfPacedCfg(CompletionEither, nil) }, false},
		{"selfPaced auto hook", func(c *Config) { *c = selfPacedCfg(CompletionAuto, hook) }, true},
		{"selfPaced no mode", func(c *Config) { *c = selfPacedCfg("", nil) }, false},
		{"selfPaced with duration", func(c *Config) { *c = selfPacedCfg(CompletionManual, nil); c.RoundDurationMs = 5 }, false},
		{"bad axis", func(c *Config) { c.RequiredAxes = []input.Axis{"clutch"} }, false},
		{"zero samples", func(c *Config) { c.MaxSamplesPerRound = 0 }, false},
		{"too many samples", func(c *Config) { c.MaxSamplesPerRound = MaxSamplesPerRound + 1 }, false},
		{"zero attempts", func(c *Config) { c.MaxAttemptsPerRound = 0 }, false},
		{"too many attempts", func(c *Config) { c.MaxAttemptsPerRound = MaxAttemptsPerRound + 1 }, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := timedCfg()
			tc.mut(&c)
			if err := c.Validate(); (err == nil) != tc.ok {
				t.Fatalf("ok=%v, err=%v", tc.ok, err)
			}
		})
	}
}

func TestConfigureRequiresIdleAndValid(t *testing.T) {
	s := New()
	wantState(t, s, Idle)
	bad := timedCfg()
	bad.Rounds = 0
	if err := s.Configure(bad); err == nil {
		t.Fatal("invalid config accepted")
	}
	wantState(t, s, Idle)
	if err := s.Configure(timedCfg()); err != nil {
		t.Fatal(err)
	}
	wantState(t, s, Prepare)
	if err := s.Configure(timedCfg()); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("reconfigure in PREPARE: %v", err)
	}
}

// 8 rounds: 3000 countdown + 8*10000 active + 7*(5000 rest + 3000 countdown).
const fullSessionEndMs = 3000 + 8*10000 + 7*8000

func checkFullSession(t *testing.T, s *Session) {
	t.Helper()
	wantState(t, s, Complete)
	at := s.Attempts()
	if len(at) != 8 || s.RoundsDone() != 8 {
		t.Fatalf("attempts=%d done=%d", len(at), s.RoundsDone())
	}
	for i, a := range at {
		start := float64(3000 + i*18000)
		if a.Round != i+1 || a.Outcome != OutcomeCompletedTimed || a.StartMs != start || a.EndMs != start+10000 {
			t.Fatalf("attempt %d: %+v", i, a)
		}
	}
}

func TestFullTimedSessionStepped(t *testing.T) {
	s := mustNew(t, timedCfg())
	var evs []Event
	evs = append(evs, must(s.Dispatch(CmdStart, 0))...)
	for now := 0.0; now <= fullSessionEndMs+1000; now += 100 {
		evs = append(evs, must(s.Observe(frame(now, 0.4)))...)
	}
	checkFullSession(t, s)
	if n := count(evs, EvCountdown); n != 24 {
		t.Fatalf("countdown events = %d, want 24", n)
	}
	if count(evs, EvRoundStarted) != 8 || count(evs, EvRoundEnded) != 8 || count(evs, EvSessionComplete) != 1 {
		t.Fatalf("event counts wrong")
	}
	// Frames recorded per round: active is [start, start+10000) sampled at 100ms.
	if got := len(s.Attempts()[0].Frames); got != 100 {
		t.Fatalf("frames round 1 = %d", got)
	}
	if s.Attempts()[0].Frames[0].ReceivedMonoMs != 3000 {
		t.Fatalf("first frame not at round start")
	}
	// Countdown sequence 3,2,1 with exact times for round 1.
	var cd []Event
	for _, e := range evs {
		if e.Kind == EvCountdown && e.Round == 1 {
			cd = append(cd, e)
		}
	}
	for i, want := range []struct {
		rem int
		at  float64
	}{{3, 0}, {2, 1000}, {1, 2000}} {
		if cd[i].Remaining != want.rem || cd[i].AtMs != want.at {
			t.Fatalf("countdown %d: %+v", i, cd[i])
		}
	}
	// Events are time-ordered.
	for i := 1; i < len(evs); i++ {
		if evs[i].AtMs < evs[i-1].AtMs {
			t.Fatalf("events out of order at %d", i)
		}
	}
}

// A single late tick must yield identical timing (no drift from chaining).
func TestFullTimedSessionSingleTick(t *testing.T) {
	s := mustNew(t, timedCfg())
	evs := must(s.Dispatch(CmdStart, 0))
	evs = append(evs, must(s.Tick(1e6))...)
	checkFullSession(t, s)
	if count(evs, EvCountdown) != 24 || count(evs, EvSessionComplete) != 1 {
		t.Fatalf("missing events on catch-up tick: cd=%d sc=%d", count(evs, EvCountdown), count(evs, EvSessionComplete))
	}
}

func TestPauseAccounting(t *testing.T) {
	c := timedCfg()
	c.Rounds = 2
	s := mustNew(t, c)
	must(s.Dispatch(CmdStart, 0))
	// Pause countdown at 1500 for 2000 -> round 1 starts at 5000.
	must(s.Dispatch(CmdPause, 1500))
	wantState(t, s, Paused)
	must(s.Tick(3400))
	wantState(t, s, Paused)
	if _, err := s.Observe(frame(3450, 0)); err != nil {
		t.Fatal(err)
	}
	must(s.Dispatch(CmdResume, 3500))
	wantState(t, s, Countdown)
	must(s.Tick(4999))
	wantState(t, s, Countdown)
	must(s.Tick(5000))
	wantState(t, s, Active)
	// Pause active at 9000 (4000 in) for 1000 -> ends at 16000.
	must(s.Dispatch(CmdPause, 9000))
	must(s.Observe(frame(9500, 0.3))) // ignored while paused
	must(s.Dispatch(CmdResume, 10000))
	must(s.Tick(15999))
	wantState(t, s, Active)
	must(s.Tick(16000))
	wantState(t, s, Rest)
	a := s.Attempts()[0]
	if a.StartMs != 5000 || a.EndMs != 16000 || len(a.Paused) != 1 || a.Paused[0] != (Interval{9000, 10000}) || len(a.Frames) != 0 {
		t.Fatalf("attempt: %+v", a)
	}
	// Pause rest at 17000 for 500 -> countdown at 21500, round 2 at 24500.
	must(s.Dispatch(CmdPause, 17000))
	must(s.Dispatch(CmdResume, 17500))
	must(s.Tick(21499))
	wantState(t, s, Rest)
	must(s.Tick(21500))
	wantState(t, s, Countdown)
	must(s.Tick(24500))
	wantState(t, s, Active)
	must(s.Tick(34500))
	wantState(t, s, Complete)
	if a := s.Attempts()[1]; a.StartMs != 24500 || a.EndMs != 34500 || len(a.Paused) != 0 {
		t.Fatalf("attempt 2: %+v", a)
	}
}

// sessionIn drives a fresh session into the requested state.
func sessionIn(t *testing.T, st State) *Session {
	t.Helper()
	c := selfPacedCfg(CompletionManual, nil)
	c.Rounds = 1
	s := New()
	if st == Idle {
		return s
	}
	if err := s.Configure(c); err != nil {
		t.Fatal(err)
	}
	steps := map[State]func(){
		Prepare:   func() {},
		Countdown: func() { must(s.Dispatch(CmdStart, 0)) },
		Active:    func() { must(s.Dispatch(CmdStart, 0)); must(s.Tick(3000)) },
		Paused:    func() { must(s.Dispatch(CmdStart, 0)); must(s.Dispatch(CmdPause, 10)) },
		SourceLost: func() {
			must(s.Dispatch(CmdStart, 0))
			must(s.SourceLost(10))
		},
		Complete: func() { must(s.Dispatch(CmdStart, 0)); must(s.Dispatch(CmdSkipRound, 10)) },
		Aborted:  func() { must(s.Dispatch(CmdStop, 0)) },
	}
	if st == Rest {
		c.Rounds = 2
		s = mustNew(t, c)
		must(s.Dispatch(CmdStart, 0))
		must(s.Dispatch(CmdSkipRound, 10))
	} else {
		steps[st]()
	}
	wantState(t, s, st)
	return s
}

func TestCommandValidity(t *testing.T) {
	cmds := []Command{CmdStart, CmdPause, CmdResume, CmdCompleteRound, CmdSkipRound, CmdStop}
	valid := map[State][]Command{
		Idle:       {},
		Prepare:    {CmdStart, CmdStop},
		Countdown:  {CmdPause, CmdSkipRound, CmdStop},
		Active:     {CmdPause, CmdCompleteRound, CmdSkipRound, CmdStop},
		Rest:       {CmdPause, CmdStop},
		Paused:     {CmdResume, CmdStop},
		SourceLost: {CmdStop},
		Complete:   {},
		Aborted:    {},
	}
	for st, ok := range valid {
		for _, cmd := range cmds {
			s := sessionIn(t, st)
			before := s.Attempts()
			_, err := s.Dispatch(cmd, s.now)
			allowed := false
			for _, c := range ok {
				allowed = allowed || c == cmd
			}
			if allowed && err != nil {
				t.Errorf("%s/%s: unexpected error %v", st, cmd, err)
			}
			if !allowed {
				if !errors.Is(err, ErrInvalidTransition) {
					t.Errorf("%s/%s: want ErrInvalidTransition, got %v", st, cmd, err)
				}
				if s.State() != st || len(s.Attempts()) != len(before) {
					t.Errorf("%s/%s: state changed on error", st, cmd)
				}
			}
		}
	}
	if _, err := sessionIn(t, Prepare).Dispatch("dance", 0); err == nil {
		t.Error("unknown command accepted")
	}
}

// An invalid command must not even apply the timer advance it would imply.
func TestInvalidCommandChangesNothing(t *testing.T) {
	s := mustNew(t, timedCfg())
	must(s.Dispatch(CmdStart, 0))
	if _, err := s.Dispatch(CmdResume, 5000); err == nil {
		t.Fatal("resume accepted in ACTIVE")
	}
	wantState(t, s, Countdown)
	evs := must(s.Tick(4000)) // earlier than the rejected 5000: still allowed
	if count(evs, EvRoundStarted) != 1 {
		t.Fatal("expected round start on tick")
	}
}

func TestSkip(t *testing.T) {
	c := timedCfg()
	c.Rounds = 2
	s := mustNew(t, c)
	must(s.Dispatch(CmdStart, 0))
	must(s.Dispatch(CmdSkipRound, 1000)) // skip from countdown
	wantState(t, s, Rest)
	must(s.Tick(1000 + 5000 + 3000))
	wantState(t, s, Active)
	must(s.Observe(frame(9500, 0.2)))
	evs := must(s.Dispatch(CmdSkipRound, 10000))
	wantState(t, s, Complete)
	if count(evs, EvSessionComplete) != 1 {
		t.Fatal("no session complete event")
	}
	at := s.Attempts()
	if len(at) != 2 || at[0].Outcome != OutcomeSkipped || at[1].Outcome != OutcomeSkipped || len(at[1].Frames) != 1 {
		t.Fatalf("attempts: %+v", at)
	}
	if at[0].StartMs != 1000 || at[0].EndMs != 1000 || at[1].StartMs != 9000 || at[1].EndMs != 10000 {
		t.Fatalf("skip times: %+v", at)
	}
}

func TestSelfPacedCompletion(t *testing.T) {
	hook := func(f input.Frame) bool { return *f.Brake.Normalized >= 0.9 }
	tests := []struct {
		mode       CompletionMode
		manualOK   bool
		autoWorks  bool
		wantByAuto Outcome
	}{
		{CompletionManual, true, false, ""},
		{CompletionAuto, false, true, OutcomeCompletedAuto},
		{CompletionEither, true, true, OutcomeCompletedAuto},
	}
	for _, tc := range tests {
		t.Run(string(tc.mode), func(t *testing.T) {
			var h func(input.Frame) bool
			if tc.mode != CompletionManual {
				h = hook
			}
			c := selfPacedCfg(tc.mode, h)
			c.Rounds = 2
			s := mustNew(t, c)
			must(s.Dispatch(CmdStart, 0))
			must(s.Tick(3000))
			must(s.Observe(frame(60000, 0.5))) // no time limit in self-paced
			wantState(t, s, Active)
			// Round 1: manual completion.
			_, err := s.Dispatch(CmdCompleteRound, 61000)
			if (err == nil) != tc.manualOK {
				t.Fatalf("manual err=%v", err)
			}
			if tc.manualOK {
				if a := s.Attempts()[0]; a.Outcome != OutcomeCompletedManual || a.EndMs != 61000 {
					t.Fatalf("manual attempt: %+v", a)
				}
				must(s.Tick(61000 + 8000))
			}
			wantState(t, s, Active)
			// Next: frame satisfying the hook.
			must(s.Observe(frame(70000, 0.95)))
			if !tc.autoWorks {
				wantState(t, s, Active)
				return
			}
			last := s.Attempts()[len(s.Attempts())-1]
			if last.Outcome != tc.wantByAuto || last.EndMs != 70000 || len(last.Frames) == 0 {
				t.Fatalf("auto attempt: %+v", last)
			}
		})
	}
	// Timed sessions reject manual completion.
	s := mustNew(t, timedCfg())
	must(s.Dispatch(CmdStart, 0))
	must(s.Tick(3000))
	if _, err := s.Dispatch(CmdCompleteRound, 3001); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("timed manual completion: %v", err)
	}
}

func TestHookOnlySeesActiveFrames(t *testing.T) {
	calls := 0
	s := mustNew(t, selfPacedCfg(CompletionAuto, func(input.Frame) bool { calls++; return false }))
	must(s.Dispatch(CmdStart, 0))
	must(s.Observe(frame(100, 1)))
	must(s.Dispatch(CmdPause, 3500))
	must(s.Observe(frame(3600, 1)))
	if calls != 0 {
		t.Fatalf("hook called %d times outside ACTIVE", calls)
	}
	must(s.Dispatch(CmdResume, 4000))
	must(s.Observe(frame(4100, 1)))
	if calls != 1 {
		t.Fatalf("hook calls = %d", calls)
	}
}

func TestSourceLost(t *testing.T) {
	gap := func(t float64) input.Frame { f := frame(t, 0.3); f.Quality.Gap = true; return f }
	stale := func(t float64) input.Frame { f := frame(t, 0.3); f.Quality.Stale = true; return f }
	noSteer := func(t float64) input.Frame {
		f := frame(t, 0.3)
		f.Steering = input.Measurement{RawUnit: "none"}
		return f
	}
	tests := []struct {
		name string
		lose func(s *Session) ([]Event, error)
	}{
		{"gap frame", func(s *Session) ([]Event, error) { return s.Observe(gap(5000)) }},
		{"stale frame", func(s *Session) ([]Event, error) { return s.Observe(stale(5000)) }},
		{"required axis unavailable", func(s *Session) ([]Event, error) { return s.Observe(noSteer(5000)) }},
		{"explicit", func(s *Session) ([]Event, error) { return s.SourceLost(5000) }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := timedCfg()
			c.Rounds = 1
			c.RequiredAxes = []input.Axis{input.AxisBrake, input.AxisSteering}
			s := mustNew(t, c)
			must(s.Dispatch(CmdStart, 0))
			must(s.Observe(frame(4000, 0.2)))
			evs := must(tc.lose(s))
			wantState(t, s, SourceLost)
			if count(evs, EvRoundEnded) != 1 {
				t.Fatal("no round ended event")
			}
			must(s.Tick(50000)) // timers frozen while lost
			wantState(t, s, SourceLost)
			must(s.Observe(frame(50001, 0.2))) // frames ignored while lost
			must(s.SourceRestored(60000))
			wantState(t, s, Countdown)
			must(s.Tick(63000))
			wantState(t, s, Active)
			must(s.Tick(73000))
			wantState(t, s, Complete)
			at := s.Attempts()
			if len(at) != 2 || s.RoundsDone() != 1 {
				t.Fatalf("attempts=%d done=%d", len(at), s.RoundsDone())
			}
			if at[0].Round != 1 || at[0].Outcome != OutcomeInvalidSourceLost || at[0].EndMs != 5000 || at[0].Frames[0].ReceivedMonoMs != 4000 {
				t.Fatalf("invalid attempt overwritten/wrong: %+v", at[0])
			}
			if at[1].Round != 1 || at[1].Outcome != OutcomeCompletedTimed || at[1].StartMs != 63000 {
				t.Fatalf("retry attempt: %+v", at[1])
			}
		})
	}
}

func TestSourceLostOutsideActive(t *testing.T) {
	c := timedCfg()
	c.Rounds = 2
	s := mustNew(t, c)
	must(s.Dispatch(CmdStart, 0))
	f := frame(100, 0)
	f.Quality.Gap = true
	must(s.Observe(f)) // bad frame outside ACTIVE: ignored
	wantState(t, s, Countdown)
	must(s.Tick(13000))
	wantState(t, s, Rest)
	must(s.SourceLost(14000))
	wantState(t, s, SourceLost)
	must(s.SourceRestored(15000))
	wantState(t, s, Countdown)
	if s.RoundsDone() != 1 || len(s.Attempts()) != 1 {
		t.Fatal("source loss during rest must not create an attempt")
	}
	if _, err := New().SourceRestored(0); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("restore in IDLE: %v", err)
	}
	if _, err := New().SourceLost(0); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("lost in IDLE: %v", err)
	}
}

func TestPausedActiveSourceLostAndStop(t *testing.T) {
	s := mustNew(t, timedCfg())
	must(s.Dispatch(CmdStart, 0))
	must(s.Dispatch(CmdPause, 4000))
	must(s.SourceLost(4500))
	a := s.Attempts()[0]
	if a.Outcome != OutcomeInvalidSourceLost || len(a.Paused) != 1 || a.Paused[0] != (Interval{4000, 4500}) {
		t.Fatalf("attempt: %+v", a)
	}
	must(s.Dispatch(CmdStop, 5000))
	wantState(t, s, Aborted)

	s = mustNew(t, timedCfg())
	must(s.Dispatch(CmdStart, 0))
	must(s.Tick(4000))
	must(s.Dispatch(CmdStop, 4200))
	if a := s.Attempts()[0]; a.Outcome != OutcomeAborted || a.EndMs != 4200 {
		t.Fatalf("aborted attempt: %+v", a)
	}
}

func TestTimeValidation(t *testing.T) {
	s := mustNew(t, timedCfg())
	must(s.Dispatch(CmdStart, 100))
	for _, bad := range []float64{50, math.NaN(), math.Inf(1), -1} {
		if _, err := s.Tick(bad); !errors.Is(err, ErrTime) {
			t.Fatalf("Tick(%v): %v", bad, err)
		}
	}
	if _, err := s.Observe(frame(99, 0)); !errors.Is(err, ErrTime) {
		t.Fatalf("old frame: %v", err)
	}
	if _, err := s.Dispatch(CmdPause, 99); !errors.Is(err, ErrTime) {
		t.Fatalf("old command: %v", err)
	}
	wantState(t, s, Countdown)
	bad := frame(200, 0)
	bad.SchemaVersion = 9
	if _, err := s.Observe(bad); err == nil {
		t.Fatal("invalid frame accepted")
	}
	must(s.Tick(100)) // equal time is fine
}

func TestTruncation(t *testing.T) {
	c := selfPacedCfg(CompletionManual, nil)
	c.MaxSamplesPerRound = 5
	c.CountdownMs = 0
	s := mustNew(t, c)
	must(s.Dispatch(CmdStart, 0))
	for i := range 10 {
		must(s.Observe(frame(float64(i), 0)))
	}
	must(s.Dispatch(CmdCompleteRound, 20))
	a := s.Attempts()[0]
	if len(a.Frames) != 5 || !a.Truncated || a.Frames[0].ReceivedMonoMs != 0 {
		t.Fatalf("truncation: len=%d truncated=%v", len(a.Frames), a.Truncated)
	}
}

func TestResetNoLeakage(t *testing.T) {
	s := mustNew(t, timedCfg())
	must(s.Dispatch(CmdStart, 0))
	must(s.Observe(frame(5000, 0.1)))
	must(s.Tick(1e6))
	s.Reset()
	wantState(t, s, Idle)
	if len(s.Attempts()) != 0 || s.RoundsDone() != 0 {
		t.Fatal("state leaked across reset")
	}
	if err := s.Configure(timedCfg()); err != nil {
		t.Fatal(err)
	}
	must(s.Dispatch(CmdStart, 0)) // clock reset too
	must(s.Tick(1e6))
	checkFullSession(t, s)
}

func TestAttemptsReturnsCopy(t *testing.T) {
	s := mustNew(t, timedCfg())
	must(s.Dispatch(CmdStart, 0))
	seq, ts := uint64(7), 42.0
	f := frame(3000, 0.4)
	f.Sequence, f.SourceTimestampMs = &seq, &ts
	must(s.Observe(f))
	// Caller mutates its frame after handing it over.
	*f.Brake.Normalized, *f.Brake.RawValue, *f.Sequence, *f.SourceTimestampMs = 0.9, 0.9, 8, 43
	must(s.Tick(13000))
	got := s.Attempts()[0]
	g := got.Frames[0]
	if *g.Brake.Normalized != 0.4 || *g.Brake.RawValue != 0.4 || *g.Sequence != 7 || *g.SourceTimestampMs != 42 {
		t.Fatal("recorded frame aliases caller-owned pointers")
	}
	// Caller mutates the export.
	got.Outcome = OutcomeAborted
	*g.Brake.Normalized, *g.Steering.RawValue, *g.Sequence, *g.SourceTimestampMs = 0.1, 0.5, 9, 44
	again := s.Attempts()[0]
	a := again.Frames[0]
	if again.Outcome != OutcomeCompletedTimed || *a.Brake.Normalized != 0.4 || *a.Steering.RawValue != 0 || *a.Sequence != 7 || *a.SourceTimestampMs != 42 {
		t.Fatal("Attempts exposes internal storage")
	}
}

func TestPausedIntervalsBounded(t *testing.T) {
	c := selfPacedCfg(CompletionManual, nil)
	c.CountdownMs = 0
	s := mustNew(t, c)
	must(s.Dispatch(CmdStart, 0))
	now := 0.0
	for range MaxPausedIntervals + 50 {
		must(s.Dispatch(CmdPause, now))
		now += 2
		must(s.Dispatch(CmdResume, now))
		now++
	}
	must(s.Dispatch(CmdCompleteRound, now))
	a := s.Attempts()[0]
	if len(a.Paused) != MaxPausedIntervals || !a.PausedTruncated || a.PausedMs != 2*(MaxPausedIntervals+50) {
		t.Fatalf("paused=%d truncated=%v pausedMs=%v", len(a.Paused), a.PausedTruncated, a.PausedMs)
	}
}

// recHook records Reset calls.
type recHook struct{ resets int }

func (*recHook) Observe(input.Frame) bool { return false }
func (h *recHook) Reset()                 { h.resets++ }

func TestCompletionResetPoints(t *testing.T) {
	h := &recHook{}
	c := selfPacedCfg(CompletionAuto, nil)
	c.AutoComplete = h
	s := mustNew(t, c)
	must(s.Dispatch(CmdStart, 0))
	must(s.Tick(3000)) // attempt start
	want := 1
	for _, step := range []func() ([]Event, error){
		func() ([]Event, error) { return s.Dispatch(CmdPause, 3100) },
		func() ([]Event, error) { return s.Dispatch(CmdResume, 3200) },
		func() ([]Event, error) { return s.SourceLost(3300) },
		func() ([]Event, error) { return s.SourceRestored(3400) },
	} {
		if h.resets != want {
			t.Fatalf("resets = %d, want %d", h.resets, want)
		}
		must(step())
		want++
	}
	must(s.Tick(6400)) // retry attempt start
	if h.resets != 5 {
		t.Fatalf("resets = %d, want 5 (start, pause, resume, lost, retry start)", h.resets)
	}
}

// Real engine detector: every round needs its own full hold, and paused
// time never counts toward the hold.
func TestRealDetectorPerRoundHold(t *testing.T) {
	def := drills.DrillDefinition{ // beginner: tolerance 0.10, hold 500 ms
		SchemaVersion: drills.SchemaVersion, Type: drills.Hold, Timing: drills.SelfPaced,
		Controls: []input.Axis{input.AxisBrake},
		Phases:   []drills.Phase{{Targets: map[input.Axis]drills.Ramp{input.AxisBrake: {From: 0.4, To: 0.4}}}},
	}
	// Huge frame-gap allowance so only the session's resets can break a hold.
	det := engine.NewCompletionDetector(def, engine.CompletionConfig{ExitScale: 1.25, MaxFrameGapMs: 1e9})
	c := selfPacedCfg(CompletionAuto, nil)
	c.AutoComplete = det
	c.Rounds, c.CountdownMs, c.RestMs = 2, 1000, 1000
	s := mustNew(t, c)
	must(s.Dispatch(CmdStart, 0))
	feed := func(from, to float64) {
		must(s.Tick(from))
		for ts := from; ts <= to && s.State() == Active; ts += 10 {
			must(s.Observe(frame(ts, 0.4)))
		}
	}
	feed(1000, 2000) // round 1 active at 1000
	if a := s.Attempts(); len(a) != 1 || a[0].EndMs != 1500 {
		t.Fatalf("round 1: %+v", a)
	}
	must(s.Tick(3500)) // rest 1500-2500, countdown 2500-3500
	wantState(t, s, Active)
	feed(3500, 3800)
	wantState(t, s, Active) // latched detector would have completed at 3500
	must(s.Dispatch(CmdPause, 3800))
	must(s.Dispatch(CmdResume, 5000))
	feed(5000, 6000)
	a := s.Attempts()
	if len(a) != 2 || a[1].Outcome != OutcomeCompletedAuto || a[1].EndMs != 5500 {
		t.Fatalf("round 2 must need a fresh 500 ms hold after resume: %+v", a[len(a)-1])
	}
	wantState(t, s, Complete)
}

func TestTransitionTableCoversStates(t *testing.T) {
	for _, st := range []State{Idle, Prepare, Countdown, Active, Rest, Paused, SourceLost, Complete, Aborted} {
		if _, ok := Transitions[st]; !ok {
			t.Errorf("no transitions entry for %s", st)
		}
	}
}

// After MaxAttemptsPerRound invalid attempts the round is used up (not
// completed, not skipped); restore proceeds to the next round.
func TestAttemptCapPerRound(t *testing.T) {
	c := timedCfg()
	c.Rounds = 2
	c.MaxAttemptsPerRound = 2
	s := mustNew(t, c)
	must(s.Dispatch(CmdStart, 0))
	must(s.Tick(3000))
	must(s.SourceLost(4000))
	must(s.SourceRestored(5000))
	wantState(t, s, Countdown) // retry 1 of round 1
	must(s.Tick(8000))
	must(s.SourceLost(9000))
	wantState(t, s, SourceLost)
	if s.RoundsDone() != 0 {
		t.Fatal("round consumed before restore")
	}
	must(s.SourceRestored(10000))
	wantState(t, s, Rest)
	if s.RoundsDone() != 1 {
		t.Fatalf("done = %d", s.RoundsDone())
	}
	must(s.Tick(10000 + 5000 + 3000))
	wantState(t, s, Active)
	must(s.SourceLost(19000))
	must(s.SourceRestored(20000))
	must(s.Tick(23000))
	must(s.SourceLost(24000))
	evs := must(s.SourceRestored(25000))
	wantState(t, s, Complete)
	if count(evs, EvSessionComplete) != 1 {
		t.Fatal("no session complete")
	}
	at := s.Attempts()
	if len(at) != 4 {
		t.Fatalf("attempts = %d", len(at))
	}
	for i, a := range at {
		if a.Outcome != OutcomeInvalidSourceLost || a.Round != i/2+1 {
			t.Fatalf("attempt %d: %+v", i, a)
		}
	}
}
