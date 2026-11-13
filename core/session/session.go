// Package session is the round/session state machine (spec 3.5): countdown,
// rest, pause, completion, skip and source-loss handling. It is pure and
// deterministic: time is injected as monotonic milliseconds, and every call
// returns the events it produced. See docs/session-lifecycle.md.
package session

import (
	"errors"
	"fmt"
	"math"
	"slices"

	"github.com/arush-sal/trail-braking-trainer/core/input"
)

// State is a session lifecycle state.
type State string

// States.
const (
	Idle       State = "IDLE"
	Prepare    State = "PREPARE"
	Countdown  State = "COUNTDOWN"
	Active     State = "ACTIVE"
	Rest       State = "REST"
	Paused     State = "PAUSED"
	SourceLost State = "SOURCE_LOST"
	Complete   State = "COMPLETE"
	Aborted    State = "ABORTED"
)

// Transitions is the complete table of legal state changes. Reset (any
// state -> IDLE) is outside the table: it discards the session.
var Transitions = map[State][]State{
	Idle:       {Prepare},                                             // Configure
	Prepare:    {Countdown, Aborted},                                  // start, stop
	Countdown:  {Active, Paused, Rest, Complete, Aborted, SourceLost}, // expiry, pause, skip, stop, lost
	Active:     {Rest, Complete, Paused, Aborted, SourceLost},         // round end, pause, stop, lost
	Rest:       {Countdown, Paused, Aborted, SourceLost},              // expiry, pause, stop, lost
	Paused:     {Countdown, Active, Rest, Aborted, SourceLost},        // resume, stop, lost
	SourceLost: {Countdown, Rest, Complete, Aborted},                  // restored (same round, or next once capped), stop
	Complete:   {},
	Aborted:    {},
}

// Command is a session command; all go through Dispatch.
type Command string

// Commands (spec 3.5).
const (
	CmdStart         Command = "start"
	CmdPause         Command = "pause"
	CmdResume        Command = "resume"
	CmdCompleteRound Command = "completeRound"
	CmdSkipRound     Command = "skipRound"
	CmdStop          Command = "stop"
)

// Outcome is how a round attempt ended. Only completed* and skipped consume
// a round; skipped is never a valid completed attempt.
type Outcome string

// Outcomes.
const (
	OutcomeCompletedTimed    Outcome = "completedTimed"
	OutcomeCompletedAuto     Outcome = "completedAuto"
	OutcomeCompletedManual   Outcome = "completedManual"
	OutcomeSkipped           Outcome = "skipped"
	OutcomeInvalidSourceLost Outcome = "invalidSourceLost"
	OutcomeAborted           Outcome = "aborted"
)

// EventKind names an event.
type EventKind string

// Event kinds.
const (
	EvStateChanged    EventKind = "stateChanged"
	EvCountdown       EventKind = "countdown" // Remaining = whole seconds left (3,2,1)
	EvRoundStarted    EventKind = "roundStarted"
	EvRoundEnded      EventKind = "roundEnded" // Outcome says completed/skipped/invalid/aborted
	EvSessionComplete EventKind = "sessionComplete"
)

// Event is emitted at AtMs (the exact scheduled time, not the call time).
type Event struct {
	Kind      EventKind `json:"kind"`
	AtMs      float64   `json:"atMs"`
	Round     int       `json:"round,omitempty"`
	From      State     `json:"from,omitempty"`
	To        State     `json:"to,omitempty"`
	Remaining int       `json:"remaining,omitempty"`
	Outcome   Outcome   `json:"outcome,omitempty"`
}

// MaxPausedIntervals caps the pause intervals recorded per attempt.
const MaxPausedIntervals = 256

// Interval is a closed span of monotonic ms.
type Interval struct {
	StartMs float64 `json:"startMs"`
	EndMs   float64 `json:"endMs"`
}

// Attempt records one try at a round. Frames[0] is the first ACTIVE frame
// (initial offset); at most MaxSamplesPerRound frames are kept, later ones
// are dropped and Truncated is set.
type Attempt struct {
	Round   int        `json:"round"`
	StartMs float64    `json:"startMs"`
	EndMs   float64    `json:"endMs"`
	Paused  []Interval `json:"paused"`
	// PausedMs is the exact total paused time; PausedTruncated is set when
	// more than MaxPausedIntervals intervals occurred (later ones dropped).
	PausedMs        float64       `json:"pausedMs"`
	PausedTruncated bool          `json:"pausedTruncated"`
	Outcome         Outcome       `json:"outcome"`
	Frames          []input.Frame `json:"frames"`
	Truncated       bool          `json:"truncated"`
}

// Errors.
var (
	ErrInvalidTransition = errors.New("invalid transition")
	ErrTime              = errors.New("invalid time")
)

// Session is the state machine. Use New; not safe for concurrent use.
//
// Invariant relied on by the rollback in do(): existing elements of
// attempts are never mutated, and cur is a value, so a shallow copy of
// Session is a complete snapshot.
type Session struct {
	cfg      Config
	state    State
	now      float64
	done     int // rounds finished: completed, skipped or used up by the attempt cap
	invalids int // invalidSourceLost attempts in the current round

	phaseStart  float64 // start of the current countdown/active/rest phase
	phasePaused float64 // total paused ms within that phase
	pausedFrom  State
	pauseStart  float64
	lastValid   float64 // last valid ACTIVE frame (or attempt start), shifted by pauses
	holdEnd     bool    // a frame stamped exactly at a timed round's end still belongs to it
	announce    int     // next countdown second to announce

	cur      Attempt // open attempt while ACTIVE (or PAUSED from ACTIVE)
	attempts []Attempt
	out      []Event
}

// New returns an IDLE session.
func New() *Session { return &Session{state: Idle} }

// Reset discards everything (config, clock, attempts) and returns to IDLE.
func (s *Session) Reset() { *s = Session{state: Idle} }

// Configure validates c and moves IDLE -> PREPARE.
func (s *Session) Configure(c Config) error {
	if s.state != Idle {
		return fmt.Errorf("%w: configure in %s (reset first)", ErrInvalidTransition, s.state)
	}
	if err := c.Validate(); err != nil {
		return err
	}
	c.RequiredAxes = slices.Clone(c.RequiredAxes)
	s.cfg = c
	s.state = Prepare
	return nil
}

// State returns the current state.
func (s *Session) State() State { return s.state }

// RoundsDone returns the number of finished rounds (completed, skipped, or
// used up by MaxAttemptsPerRound invalid attempts).
func (s *Session) RoundsDone() int { return s.done }

// Attempts returns a copy of the finished attempts in order.
func (s *Session) Attempts() []Attempt {
	out := make([]Attempt, len(s.attempts))
	for i, a := range s.attempts {
		a.Paused = slices.Clone(a.Paused)
		a.Frames = make([]input.Frame, len(a.Frames))
		for j, f := range s.attempts[i].Frames {
			a.Frames[j] = cloneFrame(f)
		}
		out[i] = a
	}
	return out
}

// ActiveElapsedMs returns the unpaused ACTIVE time of the open attempt at
// nowMs (never earlier than the last accepted time; frozen while paused),
// and false when no attempt is open. It is a read-only view: it fires no
// timers, so a timed round may report more than roundDurationMs until the
// next Tick ends it.
func (s *Session) ActiveElapsedMs(nowMs float64) (float64, bool) {
	switch {
	case s.state == Active:
		if !(nowMs > s.now) { // also rejects NaN
			nowMs = s.now
		}
		return nowMs - s.phaseStart - s.phasePaused, true
	case s.state == Paused && s.pausedFrom == Active:
		return s.pauseStart - s.phaseStart - s.phasePaused, true
	}
	return 0, false
}

// Tick advances the clock, firing any expired countdown/rest/round timers.
func (s *Session) Tick(nowMs float64) ([]Event, error) { return s.do(nowMs, nil) }

// Dispatch is the single entry point for session commands. Timers are
// advanced to nowMs first; an invalid command (or time) changes nothing.
func (s *Session) Dispatch(cmd Command, nowMs float64) ([]Event, error) {
	return s.do(nowMs, func() error {
		switch cmd {
		case CmdStart:
			if s.state != Prepare {
				return s.invalid(cmd)
			}
			s.enterCountdown()
		case CmdPause:
			if s.state != Countdown && s.state != Active && s.state != Rest {
				return s.invalid(cmd)
			}
			s.pausedFrom, s.pauseStart = s.state, s.now
			s.resetCompletion()
			s.setState(Paused, s.now)
		case CmdResume:
			if s.state != Paused {
				return s.invalid(cmd)
			}
			s.phasePaused += s.now - s.pauseStart
			if s.pausedFrom == Active {
				s.lastValid += s.now - s.pauseStart // paused time is not silence
				s.addPause()
			}
			s.resetCompletion()
			s.setState(s.pausedFrom, s.now)
		case CmdCompleteRound:
			if s.state != Active || (s.cfg.Completion != CompletionManual && s.cfg.Completion != CompletionEither) {
				return s.invalid(cmd)
			}
			s.endRound(OutcomeCompletedManual)
		case CmdSkipRound:
			switch s.state {
			case Countdown:
				s.cur = Attempt{Round: s.done + 1, StartMs: s.now}
			case Active:
			default:
				return s.invalid(cmd)
			}
			s.endRound(OutcomeSkipped)
		case CmdStop:
			if s.state == Idle || s.state == Complete || s.state == Aborted {
				return s.invalid(cmd)
			}
			if s.attemptOpen() {
				s.closeAttempt(OutcomeAborted)
			}
			s.setState(Aborted, s.now)
		default:
			return fmt.Errorf("%w: unknown command %q", ErrInvalidTransition, cmd)
		}
		return nil
	})
}

// Observe feeds one input frame; its ReceivedMonoMs is the clock. Frames
// outside ACTIVE are ignored. During ACTIVE a gap/stale frame or a missing
// required axis invalidates the attempt (SOURCE_LOST).
func (s *Session) Observe(f input.Frame) ([]Event, error) {
	if err := f.Validate(); err != nil {
		return nil, err
	}
	s.holdEnd = true
	defer func() { s.holdEnd = false }()
	return s.do(f.ReceivedMonoMs, func() error {
		s.holdEnd = false
		if s.state != Active {
			return nil
		}
		if len(s.cur.Frames) < s.cfg.MaxSamplesPerRound {
			s.cur.Frames = append(s.cur.Frames, cloneFrame(f))
		} else {
			s.cur.Truncated = true
		}
		if f.Quality.Gap || f.Quality.Stale || s.missingAxis(f) {
			s.loseSource()
			return nil
		}
		s.lastValid = f.ReceivedMonoMs
		if (s.cfg.Completion == CompletionAuto || s.cfg.Completion == CompletionEither) && s.cfg.AutoComplete.Observe(f) {
			s.endRound(OutcomeCompletedAuto)
		}
		return nil
	})
}

// SourceLost reports a lost source (disconnect, WS loss, ...). Valid while
// a session is running; an open attempt is kept as invalid.
func (s *Session) SourceLost(nowMs float64) ([]Event, error) {
	return s.do(nowMs, func() error {
		switch s.state {
		case Countdown, Active, Rest, Paused:
		default:
			return fmt.Errorf("%w: source lost in %s", ErrInvalidTransition, s.state)
		}
		s.loseSource()
		return nil
	})
}

// SourceRestored moves SOURCE_LOST -> COUNTDOWN for a fresh attempt at the
// same round number (the invalid attempt stays recorded). Once the round
// hit MaxAttemptsPerRound invalid attempts it is used up instead and the
// session moves on (REST, or COMPLETE after the last round).
func (s *Session) SourceRestored(nowMs float64) ([]Event, error) {
	return s.do(nowMs, func() error {
		if s.state != SourceLost {
			return fmt.Errorf("%w: source restored in %s", ErrInvalidTransition, s.state)
		}
		if s.invalids >= s.cfg.MaxAttemptsPerRound {
			s.finishRound()
			return nil
		}
		s.enterCountdown()
		return nil
	})
}

// do validates time, advances timers, applies op and advances again. On any
// error the session is restored to its prior snapshot.
func (s *Session) do(now float64, op func() error) ([]Event, error) {
	if math.IsNaN(now) || math.IsInf(now, 0) || now < 0 {
		return nil, fmt.Errorf("%w: %v is not a finite non-negative time", ErrTime, now)
	}
	if now < s.now {
		return nil, fmt.Errorf("%w: %v is before %v (non-monotonic)", ErrTime, now, s.now)
	}
	saved := *s
	s.now = now
	s.advance()
	if op != nil {
		if err := op(); err != nil {
			*s = saved
			return nil, err
		}
		s.advance()
	}
	out := s.out
	s.out = nil
	return out, nil
}

// advance fires every timer that expired by s.now, each at its exact
// scheduled time: end = phaseStart + pausedTotal + duration. No drift.
func (s *Session) advance() {
	for {
		var dur float64
		switch s.state {
		case Countdown:
			dur = s.cfg.CountdownMs
		case Rest:
			dur = s.cfg.RestMs
		case Active:
			dur = math.Inf(1) // self-paced: no timer, only the silence rule
			if s.cfg.Timing == TimingTimed {
				dur = s.cfg.RoundDurationMs
			}
		default:
			return
		}
		end := s.phaseStart + s.phasePaused + dur
		// Silence rule: a valid frame must arrive within MaxFrameGapMs of
		// the previous one (or the attempt start). If that deadline passes
		// before the round's end, the attempt is lost at the deadline, so a
		// timed round never completes without coverage up to its end.
		if silence := s.lastValid + s.cfg.MaxFrameGapMs; s.state == Active && silence < end && silence < s.now {
			saved := s.now
			s.now = silence
			s.loseSource()
			s.now = saved
			continue
		}
		if s.state == Active && s.holdEnd && end == s.now {
			return // the frame at the end is checked first, then the round ends
		}
		for s.state == Countdown && s.announce > 0 {
			at := max(end-float64(s.announce)*1000, s.phaseStart)
			if at > s.now {
				break
			}
			s.emit(Event{Kind: EvCountdown, AtMs: at, Round: s.done + 1, Remaining: s.announce})
			s.announce--
		}
		if end > s.now {
			return
		}
		saved := s.now
		s.now = end // transitions happen at the scheduled time
		switch s.state {
		case Countdown:
			s.enterPhase(Active)
			s.lastValid = end
			s.cur = Attempt{Round: s.done + 1, StartMs: end}
			s.resetCompletion()
			s.emit(Event{Kind: EvRoundStarted, AtMs: end, Round: s.done + 1})
		case Rest:
			s.enterCountdown()
		case Active:
			s.endRound(OutcomeCompletedTimed)
		}
		s.now = saved
	}
}

func (s *Session) enterPhase(st State) {
	s.setState(st, s.now)
	s.phaseStart, s.phasePaused = s.now, 0
}

func (s *Session) enterCountdown() {
	s.enterPhase(Countdown)
	s.announce = int(math.Ceil(s.cfg.CountdownMs / 1000))
}

// endRound closes the open attempt with a round-consuming outcome and moves
// to REST, or COMPLETE after the last round.
func (s *Session) endRound(o Outcome) {
	s.closeAttempt(o)
	s.finishRound()
}

func (s *Session) finishRound() {
	s.done++
	s.invalids = 0
	if s.done >= s.cfg.Rounds {
		s.setState(Complete, s.now)
		s.emit(Event{Kind: EvSessionComplete, AtMs: s.now})
		return
	}
	s.enterPhase(Rest)
}

func (s *Session) closeAttempt(o Outcome) {
	if s.state == Paused {
		s.addPause()
	}
	if o == OutcomeInvalidSourceLost {
		s.invalids++
	}
	s.cur.EndMs, s.cur.Outcome = s.now, o
	s.attempts = append(s.attempts, s.cur)
	s.emit(Event{Kind: EvRoundEnded, AtMs: s.now, Round: s.cur.Round, Outcome: o})
	s.cur = Attempt{}
}

// loseSource keeps an open attempt as invalid and enters SOURCE_LOST.
func (s *Session) loseSource() {
	if s.attemptOpen() {
		s.closeAttempt(OutcomeInvalidSourceLost)
	}
	s.resetCompletion()
	s.setState(SourceLost, s.now)
}

// resetCompletion clears hook state. The hook lives outside the session
// snapshot, so a rolled-back call may have reset it; that is harmless
// because Reset is idempotent and no frame is observed in between.
func (s *Session) resetCompletion() {
	if s.cfg.AutoComplete != nil {
		s.cfg.AutoComplete.Reset()
	}
}

// addPause records the pause ending now on the open attempt: PausedMs stays
// exact, the interval list is capped at MaxPausedIntervals.
func (s *Session) addPause() {
	s.cur.PausedMs += s.now - s.pauseStart
	if len(s.cur.Paused) < MaxPausedIntervals {
		s.cur.Paused = append(s.cur.Paused, Interval{s.pauseStart, s.now})
	} else {
		s.cur.PausedTruncated = true
	}
}

// cloneFrame deep-copies the pointer fields so recorded frames never alias
// caller-owned memory.
func cloneFrame(f input.Frame) input.Frame {
	f.Sequence = clonePtr(f.Sequence)
	f.SourceTimestampMs = clonePtr(f.SourceTimestampMs)
	for _, m := range []*input.Measurement{&f.Brake, &f.Steering, &f.Throttle} {
		m.RawValue, m.Normalized = clonePtr(m.RawValue), clonePtr(m.Normalized)
	}
	return f
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func (s *Session) attemptOpen() bool {
	return s.state == Active || s.state == Paused && s.pausedFrom == Active
}

func (s *Session) missingAxis(f input.Frame) bool {
	for _, a := range s.cfg.RequiredAxes {
		switch {
		case a == input.AxisBrake && !f.Brake.Available,
			a == input.AxisSteering && !f.Steering.Available,
			a == input.AxisThrottle && !f.Throttle.Available:
			return true
		}
	}
	return false
}

func (s *Session) setState(to State, at float64) {
	s.emit(Event{Kind: EvStateChanged, AtMs: at, From: s.state, To: to})
	s.state = to
}

func (s *Session) emit(e Event) { s.out = append(s.out, e) }

func (s *Session) invalid(cmd Command) error {
	return fmt.Errorf("%w: %s in %s", ErrInvalidTransition, cmd, s.state)
}
