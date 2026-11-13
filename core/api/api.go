// Package api is the versioned, JSON-friendly boundary between the browser
// and the pure training core (spec 5, ADR 0007). A Runner owns one session
// plus the detectors for it and is driven by batched frames, clock ticks and
// commands; every call returns a bounded batch of typed events. It is pure
// Go (no syscall/js), so the whole contract is tested natively; cmd/wasm
// only marshals strings. Not safe for concurrent use.
package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"

	"github.com/arush-sal/trail-braking-trainer/core/drills"
	"github.com/arush-sal/trail-braking-trainer/core/engine"
	"github.com/arush-sal/trail-braking-trainer/core/input"
	"github.com/arush-sal/trail-braking-trainer/core/metrics"
	"github.com/arush-sal/trail-braking-trainer/core/session"
)

// APIVersion of this contract. Breaking changes bump it.
const APIVersion = 1

// MaxEvents bounds the events returned by one call; extra events are
// counted in Result.EventsDropped. Events are notifications: the Snapshot
// is authoritative for state.
// ponytail: plain truncation; only a pathological late Tick (e.g. a 1 h
// countdown announced in one call) can reach it. Coalesce countdowns if
// that ever matters.
const MaxEvents = 1024

// Event kinds added by the runner on top of the session's
// stateChanged/countdown/roundStarted/roundEnded/sessionComplete.
const (
	EvOverlapOnset   session.EventKind = "overlapOnset"   // brake, throttle (R-010)
	EvFluctuation    session.EventKind = "fluctuation"    // axis (R-013)
	EvPrimaryChanged session.EventKind = "primaryChanged" // axis (R-011)
)

// Event is one typed event; fields not used by a kind are omitted in JSON.
type Event struct {
	session.Event
	Axis     input.Axis `json:"axis,omitempty"`
	Brake    float64    `json:"brake,omitempty"`
	Throttle float64    `json:"throttle,omitempty"`
}

// Result is the envelope every mutating call returns.
type Result struct {
	APIVersion int     `json:"apiVersion"`
	Events     []Event `json:"events"`
	// OutOfOrder counts frames older than the session clock (dropped).
	OutOfOrder int `json:"outOfOrder,omitempty"`
	// Invalid counts frames failing the input contract (dropped);
	// FrameError is the first reason.
	Invalid       int    `json:"invalid,omitempty"`
	FrameError    string `json:"frameError,omitempty"`
	EventsDropped int    `json:"eventsDropped,omitempty"`
	Error         string `json:"error,omitempty"`
}

// StartConfig selects freeform (Controls + optional Session) or guided
// (Drill + optional Completion) training. JSON camelCase, unknown fields
// rejected.
type StartConfig struct {
	APIVersion    int          `json:"apiVersion"`
	AvailableAxes []input.Axis `json:"availableAxes"`
	// Freeform: selected controls and session settings (defaults:
	// session.DefaultConfig). requiredAxes is always the selection.
	Controls []input.Axis    `json:"controls,omitempty"`
	Session  json.RawMessage `json:"session,omitempty"`
	// Guided: rounds/rest/countdown/timing/round duration come from the drill.
	Drill *drills.DrillDefinition `json:"drill,omitempty"`
	// Completion for a self-paced drill: auto, manual or either (default).
	Completion session.CompletionMode `json:"completion,omitempty"`
	// FluctuationAlerts enables the optional fluctuation detector (R-013).
	FluctuationAlerts bool `json:"fluctuationAlerts,omitempty"`
	// NoiseFloor is the measured source noise, added to the overlap and
	// fluctuation thresholds, in [0, 0.5]. Omitted = engine.DefaultNoiseFloor.
	NoiseFloor *float64 `json:"noiseFloor,omitempty"`
}

// Snapshot is the read-only state at a time, for audio and views.
type Snapshot struct {
	APIVersion int           `json:"apiVersion"`
	State      session.State `json:"state"`
	Mode       string        `json:"mode,omitempty"` // freeform | guided
	Controls   []input.Axis  `json:"controls,omitempty"`
	// Round is the current/next round (1-based), 0 before start.
	Round      int        `json:"round"`
	Rounds     int        `json:"rounds"`
	RoundsDone int        `json:"roundsDone"`
	Primary    input.Axis `json:"primary,omitempty"`
	// ElapsedMs is the unpaused ACTIVE time of the open attempt.
	ElapsedMs *float64 `json:"elapsedMs,omitempty"`
	// Target is the desired state at ElapsedMs: timed guided drills only,
	// while an attempt is open.
	Target *drills.Sample `json:"target,omitempty"`
	// SelfPaced: there is no instantaneous target (spec 3.4), only
	// TerminalTargets (guided).
	SelfPaced       bool                   `json:"selfPaced,omitempty"`
	TerminalTargets map[input.Axis]float64 `json:"terminalTargets,omitempty"`
	Tolerance       map[input.Axis]float64 `json:"tolerance,omitempty"`
	Error           string                 `json:"error,omitempty"`
}

// PresetsInfo lists the PROPOSED defaults a UI can offer.
type PresetsInfo struct {
	APIVersion   int                                 `json:"apiVersion"`
	Difficulties map[drills.Difficulty]drills.Preset `json:"difficulties"`
	Session      session.Config                      `json:"session"`
	Overlap      engine.OverlapConfig                `json:"overlap"`
	Fluctuation  engine.FluctuationConfig            `json:"fluctuation"`
}

// Presets returns the difficulty presets and default settings.
func Presets() PresetsInfo {
	return PresetsInfo{
		APIVersion: APIVersion, Difficulties: drills.Presets, Session: session.DefaultConfig(),
		Overlap: engine.DefaultOverlapConfig(), Fluctuation: engine.DefaultFluctuationConfig(),
	}
}

var allAxes = []input.Axis{input.AxisBrake, input.AxisSteering, input.AxisThrottle}

// ValidateDrill checks a drill definition's schema and invariants (all
// channels assumed available; Start re-checks against the real source).
func ValidateDrill(data []byte) Result {
	var d drills.DrillDefinition
	err := decodeStrict(data, &d)
	if err == nil {
		err = drills.Validate(d, allAxes)
	}
	return result(nil, err)
}

// Runner owns one session and its detectors. Use New.
type Runner struct {
	sess     *session.Session
	cfg      session.Config
	drill    *drills.DrillDefinition // with defaults; nil = freeform
	controls []input.Axis
	overlap  *engine.OverlapDetector
	fluct    *engine.FluctuationDetector // nil when disabled
	oc       engine.OverlapConfig
	fc       *engine.FluctuationConfig // nil when disabled
	free     *engine.FreeformPrimary   // nil for timed guided drills
	primary  input.Axis

	out     []Event
	dropped int
}

// New returns a runner with no session (Snapshot state IDLE).
func New() *Runner { return &Runner{} }

// Start validates cfg and configures a brand-new session (IDLE ->
// PREPARE) with fresh detectors, discarding any previous one (R-027). It
// is refused while a session is running; stop it first.
func (r *Runner) Start(data []byte) Result {
	if r.sess != nil {
		switch r.sess.State() {
		case session.Prepare, session.Complete, session.Aborted:
		default:
			return result(nil, fmt.Errorf("start: session is running (%s); stop it first", r.sess.State()))
		}
	}
	var sc StartConfig
	if err := decodeStrict(data, &sc); err != nil {
		return result(nil, err)
	}
	n, err := build(sc)
	if err != nil {
		return result(nil, err)
	}
	*r = *n
	return result(nil, nil)
}

func build(sc StartConfig) (*Runner, error) {
	if sc.APIVersion != APIVersion {
		return nil, fmt.Errorf("apiVersion: must be %d, got %d", APIVersion, sc.APIVersion)
	}
	noise := engine.DefaultNoiseFloor
	if sc.NoiseFloor != nil {
		noise = *sc.NoiseFloor
	}
	if !(noise >= 0 && noise <= 0.5) {
		return nil, fmt.Errorf("noiseFloor: must be in [0,0.5], got %v", noise)
	}
	r := &Runner{}
	var err error
	if sc.Drill != nil {
		err = r.guided(sc)
	} else {
		err = r.freeform(sc)
	}
	if err != nil {
		return nil, err
	}
	r.cfg.RequiredAxes = r.controls
	r.sess = session.New()
	if err := r.sess.Configure(r.cfg); err != nil {
		return nil, err
	}
	r.oc = engine.DefaultOverlapConfig()
	r.oc.NoiseFloor = noise
	if sc.FluctuationAlerts {
		fc := engine.DefaultFluctuationConfig()
		fc.NoiseFloor = noise
		r.fc = &fc
	}
	r.resetAlerts()
	return r, nil
}

// resetAlerts gives the overlap and fluctuation detectors fresh state. It
// runs on every session state change (attempt start, pause, resume, source
// loss/restore, round end), so an episode never carries across attempts:
// they only see ACTIVE frames, and a release during REST is invisible to
// them.
func (r *Runner) resetAlerts() {
	r.overlap = engine.NewOverlapDetector(r.oc)
	if r.fc != nil {
		r.fluct = engine.NewFluctuationDetector(r.controls, *r.fc)
	}
}

func (r *Runner) freeform(sc StartConfig) error {
	if sc.Completion != "" {
		return errors.New("completion: only for a self-paced drill; freeform uses session.completion")
	}
	if err := drills.ValidateSelection(sc.Controls); err != nil {
		return err
	}
	for _, a := range sc.Controls {
		if !slices.Contains(sc.AvailableAxes, a) {
			return fmt.Errorf("controls: %s: not available from the current source", a)
		}
	}
	r.cfg = session.DefaultConfig()
	r.cfg.RoundDurationMs = 0 // absent = default below, but only for timed
	if len(sc.Session) > 0 {
		if err := decodeStrict(sc.Session, &r.cfg); err != nil {
			return fmt.Errorf("session: %w", err)
		}
	}
	if r.cfg.Timing == session.TimingTimed && r.cfg.RoundDurationMs == 0 {
		r.cfg.RoundDurationMs = session.DefaultConfig().RoundDurationMs
	}
	r.controls = slices.Clone(sc.Controls)
	r.free = engine.NewFreeformPrimary(r.controls, engine.DefaultPrimaryConfig())
	r.primary = r.controls[0]
	return nil
}

func (r *Runner) guided(sc StartConfig) error {
	if len(sc.Controls) > 0 || len(sc.Session) > 0 {
		return errors.New("start: give either drill, or controls/session (freeform)")
	}
	if err := drills.Validate(*sc.Drill, sc.AvailableAxes); err != nil {
		return err
	}
	d := sc.Drill.WithDefaults()
	r.drill, r.controls = &d, slices.Clone(d.Controls)
	r.cfg = session.DefaultConfig()
	r.cfg.Rounds, r.cfg.RestMs, r.cfg.CountdownMs = d.Rounds, *d.RestMs, *d.CountdownMs
	if d.Timing == drills.Timed {
		if sc.Completion != "" {
			return errors.New("completion: only for a self-paced drill")
		}
		r.cfg.RoundDurationMs = 0
		for _, p := range d.Phases {
			r.cfg.RoundDurationMs += p.DurationMs
		}
		r.primary = engine.GuidedPrimary(d, 0)
		return nil
	}
	// Self-paced: no time->phase mapping exists without a progress signal
	// (spec 3.4), so the primary follows engagement within the drill's
	// controls, like freeform.
	r.cfg.Timing, r.cfg.RoundDurationMs = session.TimingSelfPaced, 0
	r.cfg.Completion = sc.Completion
	if r.cfg.Completion == "" {
		r.cfg.Completion = session.CompletionEither
	}
	if r.cfg.Completion != session.CompletionManual {
		r.cfg.AutoComplete = engine.NewCompletionDetector(d, engine.DefaultCompletionConfig())
	}
	r.free = engine.NewFreeformPrimary(r.controls, engine.DefaultPrimaryConfig())
	r.primary = engine.GuidedPrimary(d, 0)
	return nil
}

var errNoSession = errors.New("no session: call start first")

// Command dispatches a session command (start, pause, resume,
// completeRound, skipRound, stop) or a source report (sourceLost,
// sourceRestored) at nowMs. An invalid command changes nothing.
func (r *Runner) Command(name string, nowMs float64) Result {
	if r.sess == nil {
		return result(nil, errNoSession)
	}
	var evs []session.Event
	var err error
	switch name {
	case "sourceLost":
		evs, err = r.sess.SourceLost(nowMs)
	case "sourceRestored":
		evs, err = r.sess.SourceRestored(nowMs)
	default:
		evs, err = r.sess.Dispatch(session.Command(name), nowMs)
	}
	return r.finish(evs, err, nowMs)
}

// Tick advances the clock to nowMs, firing expired timers.
func (r *Runner) Tick(nowMs float64) Result {
	if r.sess == nil {
		return result(nil, errNoSession)
	}
	evs, err := r.sess.Tick(nowMs)
	return r.finish(evs, err, nowMs)
}

// Observe feeds a batch of frames in order. The batch never fails as a
// whole: a frame older than the session clock (the last accepted frame,
// tick or command) is dropped and counted in OutOfOrder, a frame breaking
// the input contract is dropped and counted in Invalid. Overlap and
// fluctuation detectors only see frames accepted while ACTIVE; the
// freeform primary sees every accepted frame.
func (r *Runner) Observe(frames []input.Frame) Result {
	if r.sess == nil {
		return result(nil, errNoSession)
	}
	var res Result
	for _, f := range frames {
		evs, err := r.sess.Observe(f)
		switch {
		case errors.Is(err, session.ErrTime):
			res.OutOfOrder++
			continue
		case err != nil:
			if res.Invalid++; res.FrameError == "" {
				res.FrameError = err.Error()
			}
			continue
		}
		r.addSession(evs)
		if r.sess.State() == session.Active {
			if o, ok := r.overlap.Observe(f); ok {
				r.emit(Event{Event: session.Event{Kind: EvOverlapOnset, AtMs: o.AtMs}, Brake: o.Brake, Throttle: o.Throttle})
			}
			if r.fluct != nil {
				for _, fe := range r.fluct.Observe(f) {
					r.emit(Event{Event: session.Event{Kind: EvFluctuation, AtMs: fe.AtMs}, Axis: fe.Axis})
				}
			}
		}
		if r.free != nil {
			if a, changed := r.free.Observe(f); changed {
				r.setPrimary(a, f.ReceivedMonoMs)
			}
		}
		r.guidedPrimary(f.ReceivedMonoMs)
	}
	out := r.take()
	out.OutOfOrder, out.Invalid, out.FrameError = res.OutOfOrder, res.Invalid, res.FrameError
	return out
}

// ObserveJSON decodes a JSON array of InputFrames strictly (input.Decode:
// missing fields are invalid, never zero) and observes the valid ones.
func (r *Runner) ObserveJSON(data []byte) Result {
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return result(nil, fmt.Errorf("observe: frames must be a JSON array: %w", err))
	}
	frames := make([]input.Frame, 0, len(raw))
	invalid, first := 0, ""
	for _, m := range raw {
		f, err := input.Decode(m)
		if err != nil {
			if invalid++; first == "" {
				first = err.Error()
			}
			continue
		}
		frames = append(frames, f)
	}
	res := r.Observe(frames)
	if res.Invalid += invalid; res.FrameError == "" {
		res.FrameError = first
	}
	return res
}

// Snapshot reports the state at nowMs without advancing timers (call Tick
// first). For a timed guided drill it includes the desired target at the
// attempt's elapsed active time; self-paced drills get none (spec 3.4).
func (r *Runner) Snapshot(nowMs float64) Snapshot {
	s := Snapshot{APIVersion: APIVersion, State: session.Idle}
	if math.IsNaN(nowMs) || math.IsInf(nowMs, 0) {
		s.Error = fmt.Sprintf("snapshot: invalid time %v", nowMs)
		return s
	}
	if r.sess == nil {
		return s
	}
	s.State, s.Controls, s.Primary = r.sess.State(), r.controls, r.primary
	s.Rounds, s.RoundsDone = r.cfg.Rounds, r.sess.RoundsDone()
	if s.State != session.Prepare {
		s.Round = min(s.RoundsDone+1, s.Rounds)
	}
	s.SelfPaced = r.cfg.Timing == session.TimingSelfPaced
	e, attempt := r.elapsed(nowMs)
	if attempt {
		s.ElapsedMs = &e
	}
	s.Mode = "freeform"
	if r.drill == nil {
		return s
	}
	s.Mode = "guided"
	s.Tolerance = map[input.Axis]float64{}
	for _, a := range r.controls {
		s.Tolerance[a] = r.drill.ToleranceFor(a)
	}
	if s.SelfPaced {
		s.TerminalTargets = drills.TerminalTargets(*r.drill)
	}
	if attempt && !s.SelfPaced {
		t, _ := drills.TargetAt(*r.drill, e)
		s.Target = &t
	}
	return s
}

// elapsed is the open attempt's active time, capped at a timed round's
// duration (Tick ends the round; until then the final target is held).
func (r *Runner) elapsed(nowMs float64) (float64, bool) {
	e, ok := r.sess.ActiveElapsedMs(nowMs)
	if ok && r.cfg.Timing == session.TimingTimed {
		e = min(e, r.cfg.RoundDurationMs)
	}
	return e, ok
}

// guidedPrimary moves the timed guided primary with the drill phase
// (outside an attempt: phase 0 of the next round).
func (r *Runner) guidedPrimary(nowMs float64) {
	if r.drill == nil || r.free != nil {
		return
	}
	phase := 0
	if e, ok := r.elapsed(nowMs); ok {
		t, _ := drills.TargetAt(*r.drill, e)
		phase = t.Phase
	}
	r.setPrimary(engine.GuidedPrimary(*r.drill, phase), nowMs)
}

func (r *Runner) setPrimary(a input.Axis, atMs float64) {
	if a != "" && a != r.primary {
		r.primary = a
		r.emit(Event{Event: session.Event{Kind: EvPrimaryChanged, AtMs: atMs}, Axis: a})
	}
}

func (r *Runner) finish(evs []session.Event, err error, nowMs float64) Result {
	if err != nil {
		return result(nil, err)
	}
	r.addSession(evs)
	r.guidedPrimary(nowMs)
	return r.take()
}

func (r *Runner) addSession(evs []session.Event) {
	for _, e := range evs {
		if e.Kind == session.EvStateChanged {
			r.resetAlerts()
		}
		r.emit(Event{Event: e})
	}
}

func (r *Runner) emit(e Event) {
	if len(r.out) >= MaxEvents {
		r.dropped++
		return
	}
	r.out = append(r.out, e)
}

func (r *Runner) take() Result {
	res := result(r.out, nil)
	res.EventsDropped = r.dropped
	r.out, r.dropped = nil, 0
	return res
}

func result(evs []Event, err error) Result {
	if evs == nil {
		evs = []Event{}
	}
	res := Result{APIVersion: APIVersion, Events: evs}
	if err != nil {
		res.Error = err.Error()
	}
	return res
}

func decodeStrict(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	return nil
}

// Results returns the metrics and traces of the current session's finished
// attempts (docs/results-contract.md). An open attempt is not included
// until it ends. Results live only in this Runner and are discarded by the
// next Start (R-027). Metrics are always computed from the full-resolution
// data, but full traces (unbounded by the display cap; tens of MB of JSON
// for long rounds) are returned only when includeFull is set; by default a
// round carries its downsampled display traces only.
func (r *Runner) Results(includeFull bool) metrics.SessionResults {
	if r.sess == nil {
		return metrics.SessionResults{APIVersion: APIVersion, Mode: "freeform", Rounds: []metrics.RoundResult{},
			Consistency: []metrics.Metric{}, Recommendations: []metrics.Recommendation{}, Error: errNoSession.Error()}
	}
	res := metrics.Analyze(metrics.Input{
		Drill: r.drill, Controls: r.controls, Attempts: r.sess.Attempts(),
		SelfPaced: r.cfg.Timing == session.TimingSelfPaced, NoiseFloor: r.oc.NoiseFloor,
	})
	res.APIVersion = APIVersion
	if !includeFull {
		for i := range res.Rounds {
			res.Rounds[i].Traces = nil
		}
	}
	return res
}

// MaxPreviewSamples caps PreviewSamples.
const MaxPreviewSamples = 500

// Preview is a drill's desired trajectory for a setup preview: x is
// elapsed ms (timed, via TargetAt) or normalized progress u in [0,1]
// (self-paced, via ShapeAt; there is no time axis).
type Preview struct {
	APIVersion int                      `json:"apiVersion"`
	Timed      bool                     `json:"timed"`
	XUnit      string                   `json:"xUnit"` // ms | u
	X          []float64                `json:"x"`
	Values     map[input.Axis][]float64 `json:"values"`
	Phases     []PreviewPhase           `json:"phases"`
	Error      string                   `json:"error,omitempty"`
}

// PreviewPhase is a phase start on the preview's x axis.
type PreviewPhase struct {
	Index  int     `json:"index"`
	Name   string  `json:"name,omitempty"`
	StartX float64 `json:"startX"`
}

// PreviewSamples validates a drill (all channels assumed available) and
// samples its desired values at n evenly spaced points, n clamped to
// [2, MaxPreviewSamples].
func PreviewSamples(data []byte, n int) Preview {
	p := Preview{APIVersion: APIVersion, X: []float64{}, Values: map[input.Axis][]float64{}, Phases: []PreviewPhase{}}
	var d drills.DrillDefinition
	err := decodeStrict(data, &d)
	if err == nil {
		err = drills.Validate(d, allAxes)
	}
	if err != nil {
		p.Error = err.Error()
		return p
	}
	n = min(max(n, 2), MaxPreviewSamples)
	p.Timed, p.XUnit = d.Timing == drills.Timed, "u"
	span := 1.0
	if p.Timed {
		p.XUnit, span = "ms", 0
		for _, ph := range d.Phases {
			span += ph.DurationMs
		}
	}
	for i := range n {
		x := span * float64(i) / float64(n-1)
		var s drills.Sample
		if p.Timed {
			s, _ = drills.TargetAt(d, x)
		} else {
			s = drills.ShapeAt(d, x)
		}
		p.X = append(p.X, x)
		for _, a := range d.Controls {
			p.Values[a] = append(p.Values[a], s.Values[a])
		}
	}
	for i, f := range drills.PhaseStarts(d) {
		p.Phases = append(p.Phases, PreviewPhase{Index: i, Name: d.Phases[i].Name, StartX: span * f})
	}
	return p
}
