package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/arush-sal/trail-braking-trainer/core/input"
	"github.com/arush-sal/trail-braking-trainer/core/metrics"
)

const sweepDrill = `{"schemaVersion":1,"type":"sweep","timing":"timed","controls":["brake"],"rounds":2,"countdownMs":0,"restMs":100,
	"phases":[{"name":"press","durationMs":1000,"targets":{"brake":{"from":0,"to":1}}}]}`

func TestResultsTimedGuided(t *testing.T) {
	r := New()
	if res := r.Results(false); res.Error == "" || res.APIVersion != APIVersion || res.Rounds == nil {
		t.Fatalf("results before start: %+v", res)
	}
	start(t, r, `{"apiVersion":1,`+all+`,"drill":`+sweepDrill+`}`)
	ok(t, r.Command("start", 0))
	// Round 1: ACTIVE 0..1000, exact sweep. Rest 1000..1100. Round 2:
	// ACTIVE 1100..2100, held at 0.2 (wrong).
	for now := 0.0; now <= 2100; now += 10 {
		b := 0.2
		if now <= 1000 {
			b = now / 1000
		}
		step(t, r, now, frame(now, b, 0, 0))
	}
	res := r.Results(false)
	if res.Error != "" || res.Mode != "guided" || res.Drill == nil || len(res.Rounds) != 2 {
		t.Fatalf("results: %+v", res)
	}
	r1, r2 := res.Rounds[0], res.Rounds[1]
	mae := func(rr metrics.RoundResult) float64 {
		for _, m := range rr.Accuracy {
			if m.ID == "accuracy.mae" {
				return *m.Value
			}
		}
		t.Fatal("no accuracy.mae")
		return 0
	}
	if mae(r1) > 1e-9 || mae(r2) < 20 {
		t.Errorf("mae r1=%v r2=%v", mae(r1), mae(r2))
	}
	if r1.Outcome != "completedTimed" || r1.DurationMs != 1000 || len(r1.Phases) != 1 || r1.Phases[0].Name != "press" {
		t.Errorf("round 1: %+v", r1)
	}
	tr := r.Results(true).Rounds[1].Traces[input.AxisBrake]
	if tr.T[0] != 0 || len(tr.Desired) != len(tr.T) || tr.Desired[len(tr.Desired)-1] != 1 {
		t.Errorf("round 2 trace must be on attempt time with desired: t0=%v", tr.T[0])
	}
	if len(res.Consistency) == 0 || len(res.Recommendations) != 0 {
		t.Errorf("consistency %v recs %v", res.Consistency, res.Recommendations)
	}
	b, err := json.Marshal(res)
	if err != nil || !strings.Contains(string(b), `"apiVersion":1`) || !strings.Contains(string(b), `"display"`) {
		t.Fatalf("json: %v %.200s", err, b)
	}
	// Reset by a new Start discards results (R-027).
	start(t, r, `{"apiVersion":1,`+all+`,"drill":`+sweepDrill+`}`)
	if res := r.Results(false); len(res.Rounds) != 0 {
		t.Errorf("new session leaked %d rounds", len(res.Rounds))
	}
}

// Default results carry display traces only: full-resolution traces of long
// rounds could be tens of MB of JSON. Metrics are still computed from full data.
func TestResultsFullTracesOnlyOnRequest(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"drill":`+sweepDrill+`}`)
	ok(t, r.Command("start", 0))
	for now := 0.0; now <= 2100; now++ { // ~1000 samples per round, more than the display cap would keep if downsampled
		step(t, r, now, frame(now, min(now/1000, 1), 0, 0))
	}
	lite, full := r.Results(false), r.Results(true)
	if len(lite.Rounds) != 2 || lite.Rounds[0].Traces != nil {
		t.Fatalf("default must omit full traces: %d rounds, traces=%v", len(lite.Rounds), lite.Rounds[0].Traces != nil)
	}
	b, _ := json.Marshal(lite)
	if strings.Contains(string(b), `"traces"`) || !strings.Contains(string(b), `"display"`) {
		t.Errorf("json must have display but no traces: %.300s", b)
	}
	if len(full.Rounds[0].Traces[input.AxisBrake].T) <= len(lite.Rounds[0].Display[input.AxisBrake].T) {
		t.Errorf("full trace should be finer than display")
	}
	lb, _ := json.Marshal(lite.Rounds[0].Accuracy)
	fb, _ := json.Marshal(full.Rounds[0].Accuracy)
	if string(lb) != string(fb) {
		t.Errorf("metrics must not depend on includeFull:\n%s\n%s", lb, fb)
	}
}

func TestResultsFreeformSelfPaced(t *testing.T) {
	r := New()
	start(t, r, `{"apiVersion":1,`+all+`,"controls":["brake"],"session":{"rounds":1,"countdownMs":0,"timing":"selfPaced","completion":"manual"}}`)
	ok(t, r.Command("start", 0))
	for now := 0.0; now <= 500; now += 10 {
		step(t, r, now, frame(now, 0.3, 0, 0))
	}
	ok(t, r.Command("completeRound", 500))
	res := r.Results(false)
	if res.Mode != "freeform" || len(res.Rounds) != 1 || !res.Rounds[0].SelfPaced || res.Rounds[0].Accuracy[0].Applicable || res.Rounds[0].Timing[0].Applicable {
		t.Fatalf("freeform self-paced: %+v", res)
	}
}

func TestPreviewSamples(t *testing.T) {
	p := PreviewSamples([]byte(`{"schemaVersion":1,"type":"multistage","timing":"timed","controls":["brake","steering"],"phases":[
		{"durationMs":1000,"targets":{"brake":{"from":0.8,"to":0.8}}},
		{"durationMs":1000,"targets":{"brake":{"from":0.8,"to":0},"steering":{"from":0,"to":0.5}}}]}`), 5)
	if p.Error != "" || !p.Timed || p.XUnit != "ms" || len(p.X) != 5 || p.X[4] != 2000 {
		t.Fatalf("timed preview: %+v", p)
	}
	if b := p.Values[input.AxisBrake]; b[0] != 0.8 || b[4] != 0 || p.Values[input.AxisSteering][3] != 0.25 {
		t.Errorf("values: %v", p.Values)
	}
	if len(p.Phases) != 2 || p.Phases[1].StartX != 1000 {
		t.Errorf("phases: %+v", p.Phases)
	}
	sp := PreviewSamples([]byte(`{"schemaVersion":1,"type":"progressive","timing":"selfPaced","controls":["brake"],"phases":[{"targets":{"brake":{"from":0,"to":1}}}]}`), 100000)
	if sp.Error != "" || sp.Timed || sp.XUnit != "u" || len(sp.X) != MaxPreviewSamples || sp.X[len(sp.X)-1] != 1 {
		t.Fatalf("self-paced preview: %+v", sp.Error)
	}
	if bad := PreviewSamples([]byte(`{"schemaVersion":1,"type":"hold","timing":"timed","controls":["brake","throttle"],"phases":[]}`), 10); bad.Error == "" || bad.X == nil {
		t.Errorf("invalid drill must fail with an envelope: %+v", bad)
	}
}
