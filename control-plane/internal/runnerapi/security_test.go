package runnerapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func secStart(seq int, key string, extra map[string]any) map[string]any {
	p := map[string]any{"key": key, "executor": "browser", "expected": "a página escapa o que recebe", "input": map[string]any{"url": "https://a.com/orders"}}
	for k, v := range extra {
		p[k] = v
	}
	return ev(seq, "step_started", p)
}

var xssStep = map[string]any{"node_fingerprint": "fp-orders", "security": map[string]any{"check": "xss-reflected", "severity": "high", "scope": "/orders?q"}}

func TestSecuritySteps_AnExplorationReportsAFindingOnAScreenByFingerprintAndItBecomesASecurityBug(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j, _ := f.exploreWithNode(nil) // an exploration knows its screens by fingerprint, not by id
	start := secStart(2, "sec1", xssStep)
	finish := ev(3, "step_finished", map[string]any{"key": "sec1", "result": "fail", "actual": "XSS refletido: o parâmetro q de /orders volta sem escape"})
	if c := f.events(f.runner, j.RunID, start, finish); c != http.StatusOK {
		t.Fatalf("events = %d", c)
	}
	steps := f.steps(j.RunID)
	if len(steps) != 1 || !steps[0].NodeID.Valid {
		t.Fatalf("steps = %+v, want one attached to the screen", steps)
	}
	if !strings.Contains(string(steps[0].Security), `"xss-reflected"`) {
		t.Errorf("security = %s, want the check kept on the step", steps[0].Security)
	}
	var category, check, severity, title string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT category, security_check, severity, title FROM bugs`).Scan(&category, &check, &severity, &title); err != nil {
		t.Fatalf("no bug: %v", err)
	}
	if category != "security" || check != "xss-reflected" || severity != "high" || !strings.HasPrefix(title, "Segurança · XSS refletido") {
		t.Errorf("bug = %s %s %s %q", category, check, severity, title)
	}
	// the same finding in a later run recurs instead of opening another
	if c := f.events(f.runner, j.RunID, secStart(4, "sec2", xssStep), ev(5, "step_finished", map[string]any{"key": "sec2", "result": "fail", "actual": "XSS refletido: o parâmetro q de /orders volta sem escape"})); c != http.StatusOK {
		t.Fatalf("events = %d", c)
	}
	var n int
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT count(*) FROM bugs`).Scan(&n); err != nil || n != 1 {
		t.Errorf("bugs = %d err=%v, want 1", n, err)
	}
}

func TestSecuritySteps_AScreenCleanOfTheFindingFixesIt(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	f.newRun()
	j, _ := f.lease(f.runner)
	f.events(f.runner, j.RunID, ev(1, "node_discovered", map[string]any{"fingerprint": "fp-orders", "kind": "page", "label": "/orders", "app_role": "admin", "metadata": map[string]any{}}))
	f.events(f.runner, j.RunID, secStart(2, "a", xssStep), ev(3, "step_finished", map[string]any{"key": "a", "result": "fail", "actual": "XSS refletido: q"}))
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})

	f.newRun()
	j2, _ := f.lease(f.runner2)
	f.events(f.runner2, j2.RunID, ev(1, "node_discovered", map[string]any{"fingerprint": "fp-orders", "kind": "page", "label": "/orders", "app_role": "admin", "metadata": map[string]any{}}))
	if c := f.events(f.runner2, j2.RunID, secStart(2, "a", xssStep), ev(3, "step_finished", map[string]any{"key": "a", "result": "pass", "actual": "sem reflexão"})); c != http.StatusOK {
		t.Fatalf("events = %d", c)
	}
	var status string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT status FROM bugs`).Scan(&status); err != nil || status != "fixed" {
		t.Errorf("bug = %q err=%v, want fixed by the clean check", status, err)
	}
}

func TestSecuritySteps_Validation(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j, nodeID := f.exploreWithNode(nil)
	sec := func(check, sev, scope string) map[string]any {
		return map[string]any{"node_fingerprint": "fp-orders", "security": map[string]any{"check": check, "severity": sev, "scope": scope}}
	}
	for name, extra := range map[string]map[string]any{
		"check with spaces":       sec("xss reflected", "high", ""),
		"check in capitals":       sec("XSS", "high", ""),
		"empty check":             sec("", "high", ""),
		"unknown severity":        sec("xss-reflected", "catastrophic", ""),
		"scope too long":          sec("xss-reflected", "high", strings.Repeat("a", 300)),
		"unknown screen":          {"node_fingerprint": "nope", "security": map[string]any{"check": "x1", "severity": "high"}},
		"id and fingerprint both": {"node_id": nodeID, "node_fingerprint": "fp-orders", "security": map[string]any{"check": "x1", "severity": "high"}},
		"unknown field":           {"node_fingerprint": "fp-orders", "security": map[string]any{"check": "x1", "severity": "high", "payload": "<script>"}},
	} {
		if c := f.events(f.runner, j.RunID, secStart(2, "k", extra)); c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	if n := len(f.steps(j.RunID)); n != 0 {
		t.Errorf("rejected events stored %d steps", n)
	}
}

// The regression of a screen can try the same injections as the exploration did: for that it needs the parameters the
// screen takes in its address and the search forms it has (reads only), not the data anyone typed.
func TestRegressionJob_PageTargetsCarryWhatCanBeProbedWithoutChangingAnything(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	f.newRun()
	j, _ := f.lease(f.runner)
	meta := map[string]any{
		"url":   "https://a.com/orders",
		"query": []string{"q", "page"},
		"forms": []map[string]any{
			{"label": "Buscar", "method": "GET", "action": "/orders/search", "fields": []map[string]any{{"name": "term", "type": "text"}, {"name": "when", "type": "date"}, {"name": "go", "type": "submit"}, {"name": "tok", "type": "hidden"}}},
			{"label": "Novo", "method": "POST", "action": "/orders", "fields": []map[string]any{{"name": "name", "type": "text"}}},
			{"label": "Fora", "method": "GET", "action": "https://elsewhere.example/x", "fields": []map[string]any{{"name": "q", "type": "search"}}},
		},
	}
	f.events(f.runner, j.RunID, ev(1, "node_discovered", map[string]any{"fingerprint": "fp-orders", "kind": "page", "label": "/orders", "app_role": "admin", "metadata": meta}))
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})

	if c := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "regression"}).Code; c != http.StatusCreated {
		t.Fatalf("create regression = %d", c)
	}
	rec := f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", f.runner, nil)
	var lj struct {
		Targets []struct {
			Probes []struct {
				URL    string   `json:"url"`
				Params []string `json:"params"`
			} `json:"probes"`
		} `json:"targets"`
	}
	f.h.JSON(rec, &lj)
	if len(lj.Targets) != 1 {
		t.Fatalf("targets = %+v", lj.Targets)
	}
	probes := lj.Targets[0].Probes
	if len(probes) != 2 {
		t.Fatalf("probes = %+v, want the address parameters and the one search form (not the POST form, not the form that goes elsewhere)", probes)
	}
	if probes[0].URL != "https://a.com/orders" || strings.Join(probes[0].Params, ",") != "q,page" {
		t.Errorf("address probe = %+v", probes[0])
	}
	if probes[1].URL != "https://a.com/orders/search" || strings.Join(probes[1].Params, ",") != "term" {
		t.Errorf("form probe = %+v, want its action resolved against the screen and only the fields that take free text", probes[1])
	}
}
