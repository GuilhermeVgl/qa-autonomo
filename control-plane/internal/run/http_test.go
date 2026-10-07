package run_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

func setup(t *testing.T) (h *testutil.Harness, owner, envID, prodEnvID string) {
	t.Helper()
	h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		run.Register(mux, mw, pool)
	})
	owner = h.Login("o@x.com", "owner")
	ctx := context.Background()
	p, err := project.New(h.Pool).CreateProject(ctx, project.CreateProjectParams{OrganizationID: h.OrgID, Name: "P"})
	if err != nil {
		t.Fatal(err)
	}
	mk := func(name string, prod bool) string {
		e, err := environment.New(h.Pool).CreateEnvironment(ctx, environment.CreateEnvironmentParams{
			OrganizationID: h.OrgID, ProjectID: p.ID, Name: name, BaseUrl: "https://a.com",
			AllowedHosts: []string{"a.com"}, DestructivePolicy: "block", IsProduction: prod})
		if err != nil {
			t.Fatal(err)
		}
		return e.ID.String()
	}
	return h, owner, mk("hml", false), mk("prod", true)
}

type runView struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Status  string         `json:"status"`
	GraphID string         `json:"graph_id"`
	Budget  map[string]int `json:"budget"`

	CreatedAt  *string `json:"created_at"`
	StartedAt  *string `json:"started_at"`
	FinishedAt *string `json:"finished_at"`
}

func TestCreateRun_QueuesExplorationWithGraphAndDefaultBudget(t *testing.T) {
	h, owner, env, _ := setup(t)
	rec := h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "exploration"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var r runView
	h.JSON(rec, &r)
	if r.Status != "queued" || r.Type != "exploration" || r.GraphID == "" {
		t.Fatalf("run = %+v", r)
	}
	if r.Budget["max_pages"] <= 0 || r.Budget["max_depth"] <= 0 || r.Budget["max_seconds"] <= 0 || r.Budget["max_llm_calls"] <= 0 || r.Budget["max_actions"] <= 0 {
		t.Errorf("default budget missing: %v", r.Budget)
	}

	// a second exploration gets a new graph version
	var r2 runView
	h.JSON(h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "exploration"}), &r2)
	if r2.GraphID == r.GraphID {
		t.Error("each exploration must create its own graph version")
	}

	var got runView
	h.JSON(h.Do("GET", "/api/v1/runs/"+r.ID, owner, nil), &got)
	if got.ID != r.ID {
		t.Errorf("get = %+v", got)
	}
	var list []runView
	h.JSON(h.Do("GET", "/api/v1/environments/"+env+"/runs", owner, nil), &list)
	if len(list) != 2 {
		t.Errorf("list = %+v", list)
	}

	entries, _ := audit.New(h.Pool).ListAudit(context.Background(), audit.ListAuditParams{OrganizationID: h.OrgID, Limit: 20})
	var n int
	for _, e := range entries {
		if e.Action == "run.create" {
			n++
		}
	}
	if n != 2 {
		t.Errorf("run.create audit entries = %d, want 2", n)
	}
}

func TestRunView_ExposesTimestampsForProgress(t *testing.T) {
	h, owner, env, _ := setup(t)
	var r runView
	h.JSON(h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "exploration"}), &r)
	if r.CreatedAt == nil || r.StartedAt != nil || r.FinishedAt != nil {
		t.Fatalf("queued run: created=%v started=%v finished=%v", r.CreatedAt, r.StartedAt, r.FinishedAt)
	}
	if _, err := h.Pool.Exec(context.Background(), `UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`, r.ID); err != nil {
		t.Fatal(err)
	}
	var running runView
	h.JSON(h.Do("GET", "/api/v1/runs/"+r.ID, owner, nil), &running)
	if running.StartedAt == nil || running.FinishedAt != nil {
		t.Errorf("running run: started=%v finished=%v", running.StartedAt, running.FinishedAt)
	}
}

func TestCreateRun_Rules(t *testing.T) {
	h, owner, env, prod := setup(t)
	if c := h.Do("POST", "/api/v1/environments/"+prod+"/runs", owner, map[string]any{"type": "exploration"}).Code; c != http.StatusConflict {
		t.Errorf("production = %d, want 409", c)
	}
	for name, body := range map[string]map[string]any{
		"unknown type":       {"type": "chaos"},
		"negative budget":    {"type": "exploration", "budget": map[string]int{"max_pages": -1}},
		"huge budget":        {"type": "exploration", "budget": map[string]int{"max_seconds": 999999}},
		"too many llm calls": {"type": "exploration", "budget": map[string]int{"max_llm_calls": 100000}},
		"too many actions":   {"type": "exploration", "budget": map[string]int{"max_actions": 100000}},
		"negative actions":   {"type": "exploration", "budget": map[string]int{"max_actions": -1}},
	} {
		if c := h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, body).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	zero := "00000000-0000-0000-0000-000000000000"
	if c := h.Do("POST", "/api/v1/environments/"+zero+"/runs", owner, map[string]any{"type": "exploration"}).Code; c != http.StatusNotFound {
		t.Errorf("unknown env = %d, want 404", c)
	}
	viewer := h.Login("v@x.com", "viewer")
	if c := h.Do("POST", "/api/v1/environments/"+env+"/runs", viewer, map[string]any{"type": "exploration"}).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
}

func TestCancelRun(t *testing.T) {
	h, owner, env, _ := setup(t)
	var r runView
	h.JSON(h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "exploration"}), &r)
	rec := h.Do("POST", "/api/v1/runs/"+r.ID+"/cancel", owner, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d %s", rec.Code, rec.Body)
	}
	var got runView
	h.JSON(rec, &got)
	if got.Status != "cancelled" {
		t.Errorf("status = %q", got.Status)
	}
	if c := h.Do("POST", "/api/v1/runs/"+r.ID+"/cancel", owner, nil).Code; c != http.StatusConflict {
		t.Errorf("cancel again = %d, want 409", c)
	}
}

func TestCreateRegression_NeedsAGraphWithCoveredNodes(t *testing.T) {
	h, owner, env, _ := setup(t)
	// no exploration yet: there is no graph to test
	if c := h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "regression"}).Code; c != http.StatusConflict {
		t.Errorf("regression without graph = %d, want 409", c)
	}
	// an exploration exists but no requirement is linked to any of its nodes
	if c := h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "exploration"}).Code; c != http.StatusCreated {
		t.Fatal("exploration should be created")
	}
	if c := h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "regression"}).Code; c != http.StatusConflict {
		t.Errorf("regression without covered nodes = %d, want 409", c)
	}
}

func TestCreateRegression_LimitedToOneSpec(t *testing.T) {
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		run.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld() // spec 1: REQ-001 -> /orders, REQ-002 -> /customers
	ctx := context.Background()
	path := "/api/v1/environments/" + w.EnvID.String() + "/runs"

	// a second spec whose only requirement is linked to the node that spec 1 does not cover
	sp2, err := spec.New(h.Pool).CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: h.OrgID, ProjectID: w.ProjectID, Version: 2, SourceType: "text", Title: "v2", ExtractedText: "t"})
	if err != nil {
		t.Fatal(err)
	}
	rq, err := spec.New(h.Pool).CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: h.OrgID, SpecID: sp2.ID, Key: "REQ-009", Text: "reports", Criticality: "normal", Status: "new"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 1, 'agent')`, h.OrgID, rq.ID, w.Nodes["/reports"]); err != nil {
		t.Fatal(err)
	}
	// a third spec that nothing is linked to
	sp3, err := spec.New(h.Pool).CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: h.OrgID, ProjectID: w.ProjectID, Version: 3, SourceType: "text", Title: "v3", ExtractedText: "t"})
	if err != nil {
		t.Fatal(err)
	}

	rec := h.Do("POST", path, owner, map[string]any{"type": "regression", "spec_id": sp2.ID})
	if rec.Code != http.StatusCreated {
		t.Fatalf("regression for spec 2 = %d %s", rec.Code, rec.Body)
	}
	var created struct {
		ID     string         `json:"id"`
		Budget map[string]any `json:"budget"`
	}
	h.JSON(rec, &created)
	if created.Budget["spec_id"] != sp2.ID.String() {
		t.Errorf("budget.spec_id = %v, want %s", created.Budget["spec_id"], sp2.ID)
	}
	var targets []uuid.UUID
	if err := h.Pool.QueryRow(ctx, `SELECT COALESCE(target_node_ids, '{}') FROM runs WHERE id = $1`, created.ID).Scan(&targets); err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0] != w.Nodes["/reports"] {
		t.Errorf("target nodes = %v, want only /reports", targets)
	}

	// the scope is the server's: a client cannot smuggle one in through the budget
	rec = h.Do("POST", path, owner, map[string]any{"type": "regression", "budget": map[string]any{"spec_id": sp2.ID}})
	if rec.Code != http.StatusConflict && rec.Code != http.StatusCreated {
		t.Fatalf("budget spec_id = %d", rec.Code)
	}
	var plain struct {
		Budget map[string]any `json:"budget"`
	}
	if rec.Code == http.StatusCreated {
		h.JSON(rec, &plain)
		if plain.Budget["spec_id"] != nil {
			t.Errorf("a spec_id inside the budget must be ignored, got %v", plain.Budget["spec_id"])
		}
	}

	for name, tc := range map[string]struct {
		body map[string]any
		want int
	}{
		"spec without covered nodes": {map[string]any{"type": "regression", "spec_id": sp3.ID}, http.StatusConflict},
		"unknown spec":               {map[string]any{"type": "regression", "spec_id": uuid.New()}, http.StatusNotFound},
		"spec on an exploration":     {map[string]any{"type": "exploration", "spec_id": sp2.ID}, http.StatusBadRequest},
	} {
		if c := h.Do("POST", path, owner, tc.body).Code; c != tc.want {
			t.Errorf("%s = %d, want %d", name, c, tc.want)
		}
	}
}

func TestCreateRegression_AsChosenUsersOnlyTestsTheirScreens(t *testing.T) {
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		run.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld() // /orders and /customers are covered and belong to "admin"
	ctx := context.Background()
	path := "/api/v1/environments/" + w.EnvID.String() + "/runs"

	for _, role := range []string{"admin", "operador"} {
		if _, err := environment.New(h.Pool).UpsertCredential(ctx, environment.UpsertCredentialParams{OrganizationID: h.OrgID, EnvironmentID: w.EnvID, AppRole: role, Kind: "login", PayloadEncrypted: []byte("x")}); err != nil {
			t.Fatal(err)
		}
	}
	// a screen that only the operator reaches, covered by a requirement
	var opsID uuid.UUID
	if err := h.Pool.QueryRow(ctx, `INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata) VALUES ($1, $2, 'page', 'fp-ops', '/ops', '{operador}', '{}') RETURNING id`, h.OrgID, w.GraphID).Scan(&opsID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 1, 'agent')`, h.OrgID, w.Reqs["REQ-001"], opsID); err != nil {
		t.Fatal(err)
	}

	targets := func(body map[string]any) (int, []uuid.UUID, map[string]any) {
		rec := h.Do("POST", path, owner, body)
		if rec.Code != http.StatusCreated {
			return rec.Code, nil, nil
		}
		var created struct {
			ID     string         `json:"id"`
			Budget map[string]any `json:"budget"`
		}
		h.JSON(rec, &created)
		var ids []uuid.UUID
		if err := h.Pool.QueryRow(ctx, `SELECT COALESCE(target_node_ids, '{}') FROM runs WHERE id = $1`, created.ID).Scan(&ids); err != nil {
			t.Fatal(err)
		}
		if _, err := h.Pool.Exec(ctx, `UPDATE runs SET status = 'cancelled' WHERE id = $1`, created.ID); err != nil { // frees the environment
			t.Fatal(err)
		}
		return rec.Code, ids, created.Budget
	}

	code, ids, budget := targets(map[string]any{"type": "regression", "budget": map[string]any{"roles": []string{"operador"}}})
	if code != http.StatusCreated || len(ids) != 1 || ids[0] != opsID {
		t.Fatalf("as operador = %d %v, want only /ops", code, ids)
	}
	if got, _ := budget["roles"].([]any); len(got) != 1 || got[0] != "operador" {
		t.Errorf("budget.roles = %v, want [operador] (the report says who was tested)", budget["roles"])
	}
	code, ids, _ = targets(map[string]any{"type": "regression", "budget": map[string]any{"roles": []string{"admin"}}})
	if code != http.StatusCreated || len(ids) != 2 {
		t.Errorf("as admin = %d %v, want /orders and /customers", code, ids)
	}
	// no users chosen: everything, and no list stored
	code, ids, budget = targets(map[string]any{"type": "regression"})
	if code != http.StatusCreated || len(ids) != 0 || budget["roles"] != nil {
		t.Errorf("all users = %d %v roles=%v, want no restriction", code, ids, budget["roles"])
	}
	// choosing the users together with a spec narrows by both
	code, ids, _ = targets(map[string]any{"type": "regression", "spec_id": w.SpecID, "budget": map[string]any{"roles": []string{"operador"}}})
	if code != http.StatusCreated || len(ids) != 1 || ids[0] != opsID {
		t.Errorf("spec + operador = %d %v, want only /ops (REQ-001 is linked to it)", code, ids)
	}

	// a user the environment has no credentials for, a user nobody covers, and too many users
	if c, _, _ := targets(map[string]any{"type": "regression", "budget": map[string]any{"roles": []string{"fantasma"}}}); c != http.StatusBadRequest {
		t.Errorf("unknown user = %d, want 400", c)
	}
	if _, err := environment.New(h.Pool).UpsertCredential(ctx, environment.UpsertCredentialParams{OrganizationID: h.OrgID, EnvironmentID: w.EnvID, AppRole: "gerente", Kind: "login", PayloadEncrypted: []byte("x")}); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := targets(map[string]any{"type": "regression", "budget": map[string]any{"roles": []string{"gerente"}}}); c != http.StatusConflict {
		t.Errorf("a user with no covered screens = %d, want 409 (nothing to test)", c)
	}
	many := make([]string, 21)
	for i := range many {
		many[i] = "u" + string(rune('a'+i))
	}
	if c, _, _ := targets(map[string]any{"type": "regression", "budget": map[string]any{"roles": many}}); c != http.StatusBadRequest {
		t.Errorf("21 users = %d, want 400", c)
	}
}

func TestCreateRun_BudgetsForBigApplications(t *testing.T) {
	h, owner, env, _ := setup(t)
	post := func(budget map[string]any) int {
		rec := h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "exploration", "budget": budget})
		if rec.Code == http.StatusCreated {
			var r runView
			h.JSON(rec, &r)
			if _, err := h.Pool.Exec(context.Background(), `UPDATE runs SET status = 'cancelled' WHERE id = $1`, r.ID); err != nil {
				t.Fatal(err)
			}
		}
		return rec.Code
	}
	if c := post(map[string]any{"max_pages": 2000, "max_depth": 15, "max_seconds": 14400, "max_actions": 2000}); c != http.StatusCreated {
		t.Errorf("a large budget = %d, want 201", c)
	}
	for name, b := range map[string]map[string]any{
		"pages": {"max_pages": 2001}, "depth": {"max_depth": 16}, "seconds": {"max_seconds": 14401}, "actions": {"max_actions": 2001},
	} {
		if c := post(b); c != http.StatusBadRequest {
			t.Errorf("%s past the cap = %d, want 400", name, c)
		}
	}
}

func TestCreateRegression_ConcurrencyIsBounded(t *testing.T) {
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		run.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld()
	path := "/api/v1/environments/" + w.EnvID.String() + "/runs"
	rec := h.Do("POST", path, owner, map[string]any{"type": "regression", "budget": map[string]any{"concurrency": 4}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("concurrency 4 = %d %s", rec.Code, rec.Body)
	}
	var created struct {
		ID     string         `json:"id"`
		Budget map[string]any `json:"budget"`
	}
	h.JSON(rec, &created)
	if created.Budget["concurrency"] != float64(4) {
		t.Errorf("budget.concurrency = %v, want 4 (the job carries it to the runner)", created.Budget["concurrency"])
	}
	if _, err := h.Pool.Exec(context.Background(), `UPDATE runs SET status = 'cancelled' WHERE id = $1`, created.ID); err != nil {
		t.Fatal(err)
	}
	for _, n := range []int{7, -1} {
		if c := h.Do("POST", path, owner, map[string]any{"type": "regression", "budget": map[string]any{"concurrency": n}}).Code; c != http.StatusBadRequest {
			t.Errorf("concurrency %d = %d, want 400", n, c)
		}
	}
}
