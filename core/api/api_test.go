package api

import (
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/input"
	"github.com/arush-sal/trail-braking-trainer/core/session"
)

func meas(v float64) input.Measurement {
	if math.IsNaN(v) {
		return input.Measurement{RawUnit: "none"}
	}
	return input.Measurement{Available: true, RawValue: &v, RawUnit: "ratio", Normalized: &v}
}

func frame(t, b, s, th float64) input.Frame {
	return input.Frame{SchemaVersion: 1, Source: input.SourceMock, SourceID: "test", ReceivedMonoMs: t, Brake: meas(b), Steering: meas(s), Throttle: meas(th)}
}

func ok(t *testing.T, r Result) Result {
	t.Helper()
	if r.Error != "" {
		t.Fatalf("unexpected error: %s", r.Error)
	}
	if r.APIVersion != APIVersion || r.Events == nil {
		t.Fatalf("bad envelope: %+v", r)
	}
	return r
}

func start(t *testing.T, r *Runner, cfg string) {
	t.Helper()
	ok(t, r.Start([]byte(cfg)))
}

const all = `"availableAxes":["brake","steering","throttle"]`

// step is the bridge cadence: Observe(batch) then Tick(now).
func step(t *testing.T, r *Runner, now float64, fs ...input.Frame) []Event {
	t.Helper()
	evs := ok(t, r.Observe(fs)).Events
	return append(evs, ok(t, r.Tick(now)).Events...)
}

type ev struct {
	Kind string
	At   float64
	Note string
}

func summarize(evs []Event, skip ...session.EventKind) []ev {
	out := []ev{}
	for _, e := range evs {
		if contains(skip, e.Kind) {
			continue
		}
		note := string(e.To) + string(e.Outcome) + string(e.Axis)
		if e.Kind == session.EvCountdown || e.Kind == session.EvRoundStarted {
			note = strconv.Itoa(e.Round)
		}
		out = append(out, ev{string(e.Kind), e.AtMs, note})
	}
	return out
}

func contains(ks []session.EventKind, k session.EventKind) bool {
	for _, x := range ks {
		if x == k {
			return true
		}
	}
	return false
}

func TestFreeformTwoRoundTimedSession(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake","steering","throttle"],
		"session":{"rounds":2,"countdownMs":1000,"roundDurationMs":2000,"restMs":500}}`)
	if s := r.Snapshot(0); s.State != session.Prepare || s.Mode != "freeform" || s.Primary != input.AxisBrake || s.Rounds != 2 || s.Target != nil {
		t.Fatalf("snapshot after start: %+v", s)
	}
	all := ok(t, r.Command("start", 0)).Events
	for now := 50.0; now <= 7000; now += 50 {
		th := 0.0
		if (now >= 1500 && now < 1600) || (now >= 3200 && now < 3300) { // in ACTIVE, then in REST
			th = 0.3
		}
		all = append(all, step(t, r, now, frame(now, 0.5, 0, th))...)
	}
	want := []ev{
		{"stateChanged", 0, "COUNTDOWN"}, {"countdown", 0, "1"},
		{"stateChanged", 1000, "ACTIVE"}, {"roundStarted", 1000, "1"},
		{"overlapOnset", 1500, ""},
		{"roundEnded", 3000, "completedTimed"}, {"stateChanged", 3000, "REST"},
		{"stateChanged", 3500, "COUNTDOWN"}, {"countdown", 3500, "2"},
		{"stateChanged", 4500, "ACTIVE"}, {"roundStarted", 4500, "2"},
		{"roundEnded", 6500, "completedTimed"}, {"stateChanged", 6500, "COMPLETE"}, {"sessionComplete", 6500, ""},
	}
	if got := summarize(all, EvPrimaryChanged); !reflect.DeepEqual(got, want) {
		t.Fatalf("events\n got %v\nwant %v", got, want)
	}
	// Freeform primary follows engagement in any state, with dwell.
	wantPrimary := []ev{{"primaryChanged", 1500, "throttle"}, {"primaryChanged", 1750, "brake"}, {"primaryChanged", 3200, "throttle"}, {"primaryChanged", 3450, "brake"}}
	var prim []ev
	for _, e := range summarize(all) {
		if e.Kind == string(EvPrimaryChanged) {
			prim = append(prim, e)
		}
	}
	if !reflect.DeepEqual(prim, wantPrimary) {
		t.Fatalf("primary\n got %v\nwant %v", prim, wantPrimary)
	}
	for _, e := range all {
		if e.Kind == EvOverlapOnset && (e.Brake != 0.5 || e.Throttle != 0.3) {
			t.Fatalf("overlap must carry unsuppressed values: %+v", e)
		}
	}
	if s := r.Snapshot(7000); s.State != session.Complete || s.RoundsDone != 2 {
		t.Fatalf("final snapshot %+v", s)
	}
}

func TestObserveDropsOutOfOrderAndInvalidFrames(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake"]}`)
	ok(t, r.Tick(100))
	bad := frame(130, 0, 0, 0)
	bad.SchemaVersion = 2
	res := ok(t, r.Observe([]input.Frame{frame(110, 0, 0, 0), frame(90, 0, 0, 0), frame(120, 0, 0, 0), frame(115, 0, 0, 0), bad, frame(140, 0, 0, 0)}))
	if res.OutOfOrder != 2 || res.Invalid != 1 || !strings.Contains(res.FrameError, "schemaVersion") {
		t.Fatalf("got %+v", res)
	}
	if res := ok(t, r.Tick(140)); res.Error != "" {
		t.Fatalf("clock should be at the last accepted frame: %+v", res)
	}
}

func TestObserveJSON(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake"]}`)
	f, _ := json.Marshal(frame(10, 0.2, 0, 0))
	res := ok(t, r.ObserveJSON([]byte(`[`+string(f)+`,{"schemaVersion":1}]`)))
	if res.Invalid != 1 || !strings.Contains(res.FrameError, "required") {
		t.Fatalf("missing fields must be invalid, not zero: %+v", res)
	}
	if res := r.ObserveJSON([]byte(`{}`)); res.Error == "" {
		t.Fatal("a non-array batch is a call error")
	}
}

func TestCallsBeforeStart(t *testing.T) {
	r := New()
	for _, res := range []Result{r.Tick(0), r.Command("start", 0), r.Observe(nil)} {
		if res.Error == "" || res.Events == nil {
			t.Fatalf("want error envelope, got %+v", res)
		}
	}
	if s := r.Snapshot(0); s.State != session.Idle || s.APIVersion != APIVersion {
		t.Fatalf("idle snapshot %+v", s)
	}
}

const twoPhase = `{"schemaVersion":1,"type":"multistage","timing":"timed","controls":["brake","steering"],
	"rounds":2,"restMs":0,"countdownMs":0,"phases":[
	{"durationMs":1000,"targets":{"brake":{"from":0.6,"to":0.6}}},
	{"durationMs":1000,"targets":{"brake":{"from":0.6,"to":0},"steering":{"from":0,"to":0.3}}}]}`

func TestGuidedTimedTargetsAndPrimary(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"drill":`+twoPhase+`}`)
	ok(t, r.Command("start", 0))
	// valid frames up to t (the core requires input coverage, MaxFrameGapMs)
	feed := func(from, to float64) []Event {
		var evs []Event
		for now := from; now <= to; now += 50 {
			evs = append(evs, ok(t, r.Observe([]input.Frame{frame(now, 0.5, 0.1, 0)})).Events...)
		}
		return evs
	}
	feed(0, 500)
	s := r.Snapshot(500)
	if s.Mode != "guided" || s.SelfPaced || s.Primary != input.AxisBrake || s.Target == nil || s.ElapsedMs == nil || *s.ElapsedMs != 500 {
		t.Fatalf("snapshot %+v", s)
	}
	if s.Target.Phase != 0 || s.Target.Values[input.AxisBrake] != 0.6 || s.Tolerance[input.AxisSteering] != 0.1 {
		t.Fatalf("target %+v tolerance %v", s.Target, s.Tolerance)
	}
	evs := feed(550, 1000)
	if got := summarize(evs); !reflect.DeepEqual(got, []ev{{"primaryChanged", 1000, "steering"}}) {
		t.Fatalf("phase handoff: %v", got)
	}
	feed(1050, 1500)
	if s := r.Snapshot(1500); s.Target.Phase != 1 || math.Abs(s.Target.Values[input.AxisBrake]-0.3) > 1e-12 || math.Abs(s.Target.Values[input.AxisSteering]-0.15) > 1e-12 {
		t.Fatalf("mid-ramp target %+v", s.Target)
	}
	evs = feed(1550, 2000)
	got := summarize(evs, session.EvStateChanged)
	want := []ev{{"roundEnded", 2000, "completedTimed"}, {"roundStarted", 2000, "2"}, {"primaryChanged", 2000, "brake"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round 2 restarts at phase 0\n got %v\nwant %v", got, want)
	}
	feed(2050, 2400)
	ok(t, r.Command("pause", 2400))
	if s := r.Snapshot(9000); s.State != session.Paused || *s.ElapsedMs != 400 || s.Target.Values[input.AxisBrake] != 0.6 {
		t.Fatalf("paused snapshot must freeze: %+v", s)
	}
}

const holdSelfPaced = `{"schemaVersion":1,"type":"hold","timing":"selfPaced","controls":["brake"],"rounds":1,"countdownMs":0,
	"phases":[{"targets":{"brake":{"from":0.4,"to":0.4}}}]}`

func TestGuidedSelfPacedHasNoLiveTarget(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"drill":`+holdSelfPaced+`,"completion":"auto"}`)
	ok(t, r.Command("start", 0))
	s := r.Snapshot(10)
	if !s.SelfPaced || s.Target != nil || !reflect.DeepEqual(s.TerminalTargets, map[input.Axis]float64{input.AxisBrake: 0.4}) {
		t.Fatalf("self-paced snapshot must expose only terminal targets: %+v", s)
	}
	var all []Event
	for now := 0.0; now <= 1000; now += 10 {
		all = append(all, step(t, r, now, frame(now, 0.4, 0, 0))...)
	}
	got := summarize(all, session.EvStateChanged)
	if want := []ev{{"roundEnded", 500, "completedAuto"}, {"sessionComplete", 500, ""}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestGuidedSelfPacedDefaultsToEither(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"drill":`+holdSelfPaced+`}`)
	ok(t, r.Command("start", 0))
	if evs := ok(t, r.Command("completeRound", 10)).Events; summarize(evs, session.EvStateChanged)[0].Note != "completedManual" {
		t.Fatalf("manual completion should be accepted: %v", evs)
	}
}

func TestFreshDetectorsPerSession(t *testing.T) {
	r := New()
	cfg := `{"apiVersion":1,` + all + `,"controls":["brake","steering","throttle"],"session":{"rounds":1,"countdownMs":0,"roundDurationMs":5000}}`
	start(t, r, cfg)
	ok(t, r.Command("start", 0))
	evs := step(t, r, 100, frame(100, 0.5, 0, 0.5))
	if len(summarize(evs, session.EvStateChanged, session.EvRoundStarted, EvPrimaryChanged)) != 1 {
		t.Fatalf("expected one overlap onset, got %v", summarize(evs))
	}
	ok(t, r.Command("stop", 200)) // overlap still active when session 1 ends
	start(t, r, cfg)
	ok(t, r.Command("start", 0)) // fresh session: clock restarts too
	evs = step(t, r, 100, frame(100, 0.5, 0, 0.5))
	if got := summarize(evs, session.EvStateChanged, session.EvRoundStarted, EvPrimaryChanged); len(got) != 1 || got[0].Kind != string(EvOverlapOnset) {
		t.Fatalf("an overlap episode must not leak into the next session: %v", got)
	}
}

func TestStartRejectedWhileRunning(t *testing.T) {
	r := New()
	cfg := `{"apiVersion":1,` + all + `,"controls":["brake"]}`
	start(t, r, cfg)
	start(t, r, cfg) // PREPARE: reconfigure is fine
	ok(t, r.Command("start", 0))
	if res := r.Start([]byte(cfg)); !strings.Contains(res.Error, "running") {
		t.Fatalf("got %+v", res)
	}
	ok(t, r.Command("stop", 10))
	start(t, r, cfg)
}

func TestFluctuationAlertsAreOptional(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		r := New()
		on := ""
		if enabled {
			on = `,"fluctuationAlerts":true`
		}
		start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake"],"session":{"countdownMs":0}`+on+`}`)
		ok(t, r.Command("start", 0))
		var n int
		for now := 0.0; now <= 1000; now += 10 {
			for _, e := range step(t, r, now, frame(now, 0.4+0.05*math.Sin(2*math.Pi*now/200), 0, 0)) {
				if e.Kind == EvFluctuation {
					n++
				}
			}
		}
		if want := map[bool]int{false: 0, true: 1}[enabled]; n != want {
			t.Fatalf("enabled=%v: %d alerts, want %d", enabled, n, want)
		}
	}
}

func TestStartValidation(t *testing.T) {
	bt := `{"apiVersion":1,"availableAxes":["brake","throttle"],"drill":` + twoPhase + `}`
	for _, tc := range []struct{ name, cfg, want string }{
		{"api version", `{"apiVersion":2,` + all + `,"controls":["brake"]}`, "apiVersion"},
		{"nothing selected", `{"apiVersion":1,` + all + `}`, "controls"},
		{"B+T selection", `{"apiVersion":1,` + all + `,"controls":["brake","throttle"]}`, "controls"},
		{"freeform channel unavailable", `{"apiVersion":1,"availableAxes":["brake"],"controls":["steering"]}`, "not available"},
		{"drill channel unavailable", bt, "not available"},
		{"drill and controls", `{"apiVersion":1,` + all + `,"controls":["brake"],"drill":` + twoPhase + `}`, "either"},
		{"drill and session", `{"apiVersion":1,` + all + `,"session":{},"drill":` + twoPhase + `}`, "either"},
		{"timed drill with completion", `{"apiVersion":1,` + all + `,"completion":"auto","drill":` + twoPhase + `}`, "completion"},
		{"freeform completion field", `{"apiVersion":1,` + all + `,"controls":["brake"],"completion":"manual"}`, "completion"},
		{"freeform self-paced auto", `{"apiVersion":1,` + all + `,"controls":["brake"],"session":{"timing":"selfPaced","completion":"auto"}}`, "AutoComplete"},
		{"unknown field", `{"apiVersion":1,` + all + `,"controls":["brake"],"bogus":1}`, "bogus"},
		{"unknown session field", `{"apiVersion":1,` + all + `,"controls":["brake"],"session":{"bogus":1}}`, "bogus"},
		{"noise floor", `{"apiVersion":1,` + all + `,"controls":["brake"],"noiseFloor":0.9}`, "noiseFloor"},
		{"bad json", `{`, "JSON"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := New().Start([]byte(tc.cfg))
			if !strings.Contains(res.Error, tc.want) {
				t.Fatalf("error %q, want it to mention %q", res.Error, tc.want)
			}
		})
	}
	// Freeform self-paced manual is legal and needs no roundDurationMs.
	start(t, New(), `{"apiVersion":1,`+all+`,"controls":["brake"],"session":{"timing":"selfPaced","completion":"manual"}}`)
}

func TestValidateDrillAndPresets(t *testing.T) {
	if res := ValidateDrill([]byte(twoPhase)); res.Error != "" || res.APIVersion != APIVersion {
		t.Fatalf("valid drill rejected: %+v", res)
	}
	overlap := strings.Replace(twoPhase, `"controls":["brake","steering"]`, `"controls":["brake","steering","throttle"]`, 1)
	overlap = strings.Replace(overlap, `"steering":{"from":0,"to":0.3}`, `"throttle":{"from":0,"to":0.3}`, 1)
	if res := ValidateDrill([]byte(overlap)); !strings.Contains(res.Error, "brake and throttle") {
		t.Fatalf("B/T overlap must be rejected: %+v", res)
	}
	if res := ValidateDrill([]byte(`{"schemaVersion":1,"bogus":true}`)); res.Error == "" {
		t.Fatal("unknown fields must be rejected")
	}
	p := Presets()
	if p.APIVersion != APIVersion || p.Difficulties["beginner"].Tolerance != 0.10 || p.Session.Rounds != 8 || p.Fluctuation.MinReversals != 3 {
		t.Fatalf("presets %+v", p)
	}
}

func TestEventBatchIsBounded(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake"],"session":{"countdownMs":3600000}}`)
	ok(t, r.Command("start", 0))
	res := ok(t, r.Tick(3_600_000)) // one very late tick: 3600 countdown announcements
	if len(res.Events) != MaxEvents || res.EventsDropped == 0 {
		t.Fatalf("events %d dropped %d", len(res.Events), res.EventsDropped)
	}
	if s := r.Snapshot(3_600_000); s.State != session.Active {
		t.Fatalf("the snapshot stays authoritative when events are dropped: %s", s.State)
	}
}

func TestJSONShape(t *testing.T) {
	b, _ := json.Marshal(Result{APIVersion: 1, Events: []Event{
		{Event: session.Event{Kind: EvOverlapOnset, AtMs: 5}, Brake: 0.5, Throttle: 0.3},
		{Event: session.Event{Kind: EvPrimaryChanged, AtMs: 6}, Axis: input.AxisSteering},
	}})
	want := `{"apiVersion":1,"events":[{"kind":"overlapOnset","atMs":5,"brake":0.5,"throttle":0.3},{"kind":"primaryChanged","atMs":6,"axis":"steering"}]}`
	if string(b) != want {
		t.Fatalf("\n got %s\nwant %s", b, want)
	}
}

func TestNoiseFloorOmittedKeepsDefault(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake","steering","throttle"],"session":{"countdownMs":0}}`)
	ok(t, r.Command("start", 0))
	// 0.052 is above the 0.05 enter threshold but below 0.05 + 0.005 default noise floor.
	evs := step(t, r, 10, frame(10, 0.5, 0, 0.052))
	for _, e := range evs {
		if e.Kind == EvOverlapOnset {
			t.Fatalf("omitted noiseFloor must keep the provisional default: %+v", e)
		}
	}
	r = New()
	start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake","steering","throttle"],"session":{"countdownMs":0},"noiseFloor":0}`)
	ok(t, r.Command("start", 0))
	if got := summarize(step(t, r, 10, frame(10, 0.5, 0, 0.052)), session.EvStateChanged, session.EvRoundStarted, EvPrimaryChanged); len(got) != 1 {
		t.Fatalf("explicit noiseFloor 0 must apply: %v", got)
	}
}

func TestDetectorsResetPerAttempt(t *testing.T) {
	// Overlap at the end of round 1, released during REST, overlap again as
	// round 2 starts: round 2 must alert.
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake","steering","throttle"],
		"session":{"rounds":2,"countdownMs":0,"roundDurationMs":500,"restMs":300}}`)
	ok(t, r.Command("start", 0))
	var onsets []float64
	for now := 0.0; now <= 1300; now += 10 {
		th := 0.0
		if (now >= 400 && now < 500) || (now >= 800 && now < 900) {
			th = 0.5
		}
		for _, e := range step(t, r, now, frame(now, 0.5, 0, th)) {
			if e.Kind == EvOverlapOnset {
				onsets = append(onsets, e.AtMs)
			}
		}
	}
	if !reflect.DeepEqual(onsets, []float64{400, 800}) {
		t.Fatalf("onsets %v, want [400 800]", onsets)
	}
}
