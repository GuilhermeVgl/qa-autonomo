package brief

import (
	"strings"
	"testing"
	"time"
)

func blockedRun(at time.Time, status, summary string) *runInfo {
	return &runInfo{Type: "regression", Status: status, FinishedAt: at, Summary: []byte(summary)}
}

func TestAnalyze_ABlockedLatestRunIsOneProblemWithItsReason(t *testing.T) {
	in := shop().in
	in.Latest = blockedRun(in.Now, "failed", `{"error":"x","blocked":{"kind":"login_failed","roles":["operador"],"message":"Não foi possível entrar como operador: o login não foi aceito.","details":[{"role":"operador","reason":"rejected","message":"o login não foi aceito"}]}}`)
	f := analyze(in)
	if f.Blocked == nil || f.Blocked.Kind != "login_failed" || len(f.Blocked.Roles) != 1 || f.Blocked.Roles[0] != "operador" {
		t.Fatalf("blocked = %+v", f.Blocked)
	}
	var codes []string
	for _, i := range f.Issues {
		codes = append(codes, i.Code)
	}
	if len(f.Issues) == 0 || f.Issues[0].Code != "environment_blocked" || f.Issues[0].Severity != "alta" {
		t.Fatalf("issues = %v, want the blocked run first and as alta", codes)
	}
	if !strings.Contains(f.Issues[0].Message, "operador") {
		t.Errorf("message = %q, want the reason the run gave", f.Issues[0].Message)
	}
	for _, c := range codes {
		if c == "login_failed" {
			t.Errorf("issues = %v: the login problem is said once, not twice", codes)
		}
	}
}

func TestAnalyze_ALoginFailureOfTheLastExplorationIsReportedOnlyThroughTheBlockedRun(t *testing.T) {
	in := shop().in
	in.Exploration = &runInfo{Type: "exploration", Status: "succeeded", FinishedAt: in.Now, Summary: []byte(`{"pages":4,"login_failures":["operador"],"blocked":{"kind":"login_failed","roles":["operador"],"message":"Não foi possível entrar como operador"}}`)}
	in.Latest = in.Exploration
	f := analyze(in)
	n := 0
	for _, i := range f.Issues {
		if i.Code == "login_failed" || i.Code == "environment_blocked" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("login issues = %d, want 1", n)
	}
}

func TestAnalyze_ARunThatCameAfterAndWorkedClearsTheProblem(t *testing.T) {
	in := shop().in
	in.Latest = blockedRun(in.Now, "succeeded", `{"steps":10,"passed":10}`)
	if f := analyze(in); f.Blocked != nil {
		t.Errorf("blocked = %+v, want none: the latest run worked", f.Blocked)
	}
	// and no run at all is no problem either
	in.Latest = nil
	if f := analyze(in); f.Blocked != nil {
		t.Errorf("blocked = %+v", f.Blocked)
	}
}

func TestAnalyze_AnApplicationThatWasDown(t *testing.T) {
	in := shop().in
	in.Latest = blockedRun(in.Now, "failed", `{"blocked":{"kind":"app_down","message":"A aplicação não respondeu em https://hml.loja.com: conexão recusada."}}`)
	f := analyze(in)
	if f.Blocked == nil || f.Blocked.Kind != "app_down" {
		t.Fatalf("blocked = %+v", f.Blocked)
	}
	var ready *Check
	for i := range f.Readiness {
		if f.Readiness[i].ID == "access" {
			ready = &f.Readiness[i]
		}
	}
	if ready == nil || ready.OK || !strings.Contains(ready.Detail, "fora do ar") {
		t.Errorf("readiness access = %+v, want it not ok and saying the application is down", ready)
	}
}

func TestTemplate_SaysWhatBlockedTheLastRunAndStartsTheNextStepsWithIt(t *testing.T) {
	in := shop().in
	in.Latest = blockedRun(in.Now, "failed", `{"blocked":{"kind":"login_failed","roles":["operador"],"message":"Não foi possível entrar como operador: o login não foi aceito."}}`)
	n := Template(analyze(in))
	if !strings.Contains(n.ExecutiveSummary, "bloquead") {
		t.Errorf("summary = %q, want it to say the last run was blocked", n.ExecutiveSummary)
	}
	if len(n.Recommendations) == 0 || !strings.Contains(n.Recommendations[0], "login") {
		t.Errorf("recommendations = %v, want the login first", n.Recommendations)
	}
	for _, s := range n.Sections {
		if s.ID == "results" && !strings.Contains(s.Body, "operador") {
			t.Errorf("results = %q, want what blocked the run", s.Body)
		}
	}
}

func TestAnalyze_AnEnvironmentThatWasBlockedBeforeAnyMapSaysSoFirst(t *testing.T) {
	in := input{Now: time.Now(), Project: "P", Env: envInfo{Name: "e"}}
	in.Latest = blockedRun(in.Now, "failed", `{"blocked":{"kind":"app_down","message":"A aplicação não respondeu."}}`)
	f := analyze(in)
	if len(f.Issues) < 2 || f.Issues[0].Code != "environment_blocked" || f.Issues[1].Code != "no_map" {
		t.Fatalf("issues = %+v, want the reason the first run could not map first, then the lack of a map", f.Issues)
	}
	if rec := Template(f).Recommendations; len(rec) == 0 || !strings.Contains(rec[0], "no ar") {
		t.Errorf("recommendations = %v, want to put the application up first", rec)
	}
}
