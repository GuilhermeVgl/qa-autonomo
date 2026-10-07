package report_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/report"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type reportView struct {
	Run struct {
		ID              string  `json:"id"`
		Type            string  `json:"type"`
		Status          string  `json:"status"`
		DurationSeconds float64 `json:"duration_seconds"`
	} `json:"run"`
	Steps        map[string]int `json:"steps"`
	Requirements []struct {
		Key         string `json:"key"`
		Criticality string `json:"criticality"`
		Outcome     string `json:"outcome"`
	} `json:"requirements"`
	Bugs struct {
		New       []struct{ Title, Status string } `json:"new"`
		Recurring []struct{ Title, Status string } `json:"recurring"`
		Fixed     []struct{ Title, Status string } `json:"fixed"`
	} `json:"bugs"`
	Cost struct {
		LLMCalls  int     `json:"llm_calls"`
		TokensIn  int     `json:"tokens_in"`
		TokensOut int     `json:"tokens_out"`
		Cost      float64 `json:"cost"`
	} `json:"cost"`
}

func TestRunReport_BugsNewRecurringFixedAndRequirementOutcomes(t *testing.T) {
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		report.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld()
	t0 := time.Now().Add(-3 * time.Hour)

	run1 := w.NewRun("regression", t0, time.Minute)
	w.Step(run1, "/orders", "fail", "HTTP 500") // bug A (new)
	w.Step(run1, "/customers", "pass", "ok")

	run2 := w.NewRun("regression", t0.Add(time.Hour), time.Minute)
	w.Step(run2, "/orders", "fail", "HTTP 500")    // A recurs
	w.Step(run2, "/customers", "fail", "HTTP 404") // bug B (new)

	run3 := w.NewRun("regression", t0.Add(2*time.Hour), 90*time.Second)
	w.Step(run3, "/orders", "pass", "ok")          // A fixed
	w.Step(run3, "/customers", "fail", "HTTP 404") // B recurs
	for _, in := range []int{100, 50} {
		if _, err := h.Pool.Exec(context.Background(), `INSERT INTO llm_usage (organization_id, run_id, task, provider, model, tokens_in, tokens_out, cost) VALUES ($1, $2, 'explore', 'p', 'm', $3, 10, 0.5)`, h.OrgID, run3, in); err != nil {
			t.Fatal(err)
		}
	}

	get := func(id any) (int, reportView) {
		rec := h.Do("GET", "/api/v1/runs/"+id.(interface{ String() string }).String()+"/report", owner, nil)
		var v reportView
		if rec.Code == http.StatusOK {
			h.JSON(rec, &v)
		}
		return rec.Code, v
	}

	code, r2 := get(run2)
	if code != http.StatusOK {
		t.Fatalf("report = %d", code)
	}
	if len(r2.Bugs.New) != 1 || len(r2.Bugs.Recurring) != 1 || len(r2.Bugs.Fixed) != 0 {
		t.Errorf("run2 bugs = new %d recurring %d fixed %d", len(r2.Bugs.New), len(r2.Bugs.Recurring), len(r2.Bugs.Fixed))
	}
	if r2.Steps["fail"] != 2 || r2.Steps["pass"] != 0 {
		t.Errorf("run2 steps = %v", r2.Steps)
	}

	_, r3 := get(run3)
	if len(r3.Bugs.New) != 0 || len(r3.Bugs.Recurring) != 1 || len(r3.Bugs.Fixed) != 1 {
		t.Fatalf("run3 bugs = new %d recurring %d fixed %d", len(r3.Bugs.New), len(r3.Bugs.Recurring), len(r3.Bugs.Fixed))
	}
	if r3.Bugs.Fixed[0].Status != "fixed" || r3.Bugs.Recurring[0].Status != "new" {
		t.Errorf("statuses: fixed=%s recurring=%s", r3.Bugs.Fixed[0].Status, r3.Bugs.Recurring[0].Status)
	}
	outcome := map[string]string{}
	for _, rq := range r3.Requirements {
		outcome[rq.Key] = rq.Outcome
	}
	if outcome["REQ-001"] != "pass" || outcome["REQ-002"] != "fail" {
		t.Errorf("outcomes = %v", outcome)
	}
	if r3.Run.Type != "regression" || r3.Run.Status != "succeeded" || r3.Run.DurationSeconds != 90 {
		t.Errorf("run = %+v", r3.Run)
	}
	if r3.Cost.LLMCalls != 2 || r3.Cost.TokensIn != 150 || r3.Cost.TokensOut != 20 || r3.Cost.Cost != 1.0 {
		t.Errorf("cost = %+v", r3.Cost)
	}
	_, r1 := get(run1)
	if len(r1.Bugs.New) != 1 || r1.Cost.LLMCalls != 0 {
		t.Errorf("run1 = %+v", r1.Bugs)
	}

	zero := run.View{}.ID // uuid.Nil
	if c, _ := get(zero); c != http.StatusNotFound {
		t.Errorf("unknown run = %d, want 404", c)
	}
	if c := h.Do("GET", "/api/v1/runs/"+run3.String()+"/report", "", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("anonymous = %d, want 401", c)
	}
}

func TestRunReport_SaysWhichUserWasTestedAndHowEachRequirementDidPerUser(t *testing.T) {
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		report.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld() // /orders (admin) is covered by REQ-001
	ctx := context.Background()
	// the same requirement is also covered by the operator's own version of the screen
	var opsID uuid.UUID
	if err := h.Pool.QueryRow(ctx, `INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata) VALUES ($1, $2, 'page', 'fp/orders-ops', '/orders', '{operador}', '{}') RETURNING id`, h.OrgID, w.GraphID).Scan(&opsID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 1, 'agent')`, h.OrgID, w.Reqs["REQ-001"], opsID); err != nil {
		t.Fatal(err)
	}
	w.Nodes["/orders (operador)"] = opsID

	rn := w.NewRun("regression", time.Now().Add(-time.Hour), time.Minute)
	w.Step(rn, "/orders", "pass", "ok")                  // admin
	w.Step(rn, "/customers", "pass", "ok")               // admin
	w.Step(rn, "/orders (operador)", "fail", "HTTP 403") // operador: the alternative flow is broken

	rec := h.Do("GET", "/api/v1/runs/"+rn.String()+"/report", owner, nil)
	var v struct {
		Users []struct {
			User    string `json:"user"`
			Passed  int    `json:"passed"`
			Failed  int    `json:"failed"`
			Errored int    `json:"errored"`
			Skipped int    `json:"skipped"`
		} `json:"users"`
		Requirements []struct {
			Key    string            `json:"key"`
			ByUser map[string]string `json:"by_user"`
		} `json:"requirements"`
	}
	h.JSON(rec, &v)
	if len(v.Users) != 2 {
		t.Fatalf("users = %+v, want admin and operador", v.Users)
	}
	byName := map[string][2]int{}
	for _, u := range v.Users {
		byName[u.User] = [2]int{u.Passed, u.Failed}
	}
	if byName["admin"] != [2]int{2, 0} || byName["operador"] != [2]int{0, 1} {
		t.Errorf("per user (passed, failed) = %v, want admin {2 0} and operador {0 1}", byName)
	}
	for _, rq := range v.Requirements {
		if rq.Key == "REQ-001" && (rq.ByUser["admin"] != "pass" || rq.ByUser["operador"] != "fail") {
			t.Errorf("REQ-001 by user = %v, want admin pass and operador fail", rq.ByUser)
		}
	}
}

// Security checks are reported on their own: a screen with a missing header must not fail the requirement it serves, and
// the counts of the tests are about the tests.
func TestRunReport_SecurityChecksAreCountedApartFromTheTests(t *testing.T) {
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		report.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld()
	run1 := w.NewRun("regression", time.Now().Add(-time.Hour), time.Minute)
	w.Step(run1, "/orders", "pass", "ok")
	ctx := context.Background()
	add := func(result, severity string) {
		if _, err := h.Pool.Exec(ctx, `INSERT INTO run_steps (organization_id, run_id, client_key, node_id, executor, result, security) VALUES ($1, $2, $3, $4, 'browser', $5, $6::jsonb)`,
			h.OrgID, run1, uuid.NewString(), w.Nodes["/orders"], result, `{"check":"c-`+severity+`","severity":"`+severity+`"}`); err != nil {
			t.Fatal(err)
		}
	}
	add("fail", "high")
	add("fail", "high")
	add("fail", "normal")
	add("pass", "critical")
	add("pass", "normal")

	var got struct {
		Steps        map[string]int `json:"steps"`
		Requirements []struct {
			Key     string `json:"key"`
			Outcome string `json:"outcome"`
		} `json:"requirements"`
		Security struct {
			Checks     int            `json:"checks"`
			Passed     int            `json:"passed"`
			Failed     int            `json:"failed"`
			BySeverity map[string]int `json:"by_severity"`
		} `json:"security"`
	}
	h.JSON(h.Do("GET", "/api/v1/runs/"+run1.String()+"/report", owner, nil), &got)
	if got.Steps["pass"] != 1 || got.Steps["fail"] != 0 {
		t.Errorf("steps = %v, want only the one functional pass", got.Steps)
	}
	for _, r := range got.Requirements {
		if r.Key == "REQ-001" && r.Outcome != "pass" {
			t.Errorf("REQ-001 = %q, want pass: a missing header is not a failure of the requirement", r.Outcome)
		}
	}
	if got.Security.Checks != 5 || got.Security.Passed != 2 || got.Security.Failed != 3 {
		t.Errorf("security = %+v, want 5 checks, 2 passed, 3 failed", got.Security)
	}
	if got.Security.BySeverity["high"] != 2 || got.Security.BySeverity["normal"] != 1 || got.Security.BySeverity["critical"] != 0 {
		t.Errorf("by severity = %v, want failures only: 2 high, 1 normal", got.Security.BySeverity)
	}
}
