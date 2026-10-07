package ci_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/apitoken"
	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/ci"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fx struct {
	h     *testutil.Harness
	w     *testutil.World
	owner string
}

func setup(t *testing.T) *fx {
	t.Helper()
	f := &fx{}
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		apitoken.Register(mux, mw, pool)
		ci.Register(mux, pool, "https://qa.example")
	})
	f.owner = f.h.Login("o@x.com", "owner")
	f.w = f.h.SeedWorld()
	return f
}

type tokenResp struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Token string   `json:"token"`
	Scope []string `json:"scopes"`
}

func (f *fx) newToken(scopes ...string) tokenResp {
	f.h.T.Helper()
	body := map[string]any{"name": "ci-pipeline"}
	if len(scopes) > 0 {
		body["scopes"] = scopes
	}
	rec := f.h.Do("POST", "/api/v1/projects/"+f.w.ProjectID.String()+"/tokens", f.owner, body)
	if rec.Code != http.StatusCreated {
		f.h.T.Fatalf("create token = %d %s", rec.Code, rec.Body)
	}
	var out tokenResp
	f.h.JSON(rec, &out)
	return out
}

func TestTokens_CreateShownOnceListedWithoutSecretAndRevocable(t *testing.T) {
	f := setup(t)
	tok := f.newToken()
	if !strings.HasPrefix(tok.Token, "qat_") || len(tok.Token) < 40 {
		t.Fatalf("token = %q", tok.Token)
	}
	if len(tok.Scope) != 2 {
		t.Errorf("default scopes = %v, want run:create and run:read", tok.Scope)
	}
	var stored string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT token_hash FROM api_tokens`).Scan(&stored); err != nil || stored == tok.Token || strings.Contains(stored, tok.Token) {
		t.Errorf("token must be stored hashed: %q (%v)", stored, err)
	}

	rec := f.h.Do("GET", "/api/v1/projects/"+f.w.ProjectID.String()+"/tokens", f.owner, nil)
	if strings.Contains(rec.Body.String(), tok.Token) || strings.Contains(rec.Body.String(), "token_hash") {
		t.Error("list leaks the token or its hash")
	}

	if c := f.h.Do("GET", "/ci/v1/runs/"+uuid.NewString(), tok.Token, nil).Code; c == http.StatusUnauthorized {
		t.Fatal("a fresh token must authenticate")
	}
	if c := f.h.Do("DELETE", "/api/v1/tokens/"+tok.ID, f.owner, nil).Code; c != http.StatusNoContent {
		t.Fatalf("revoke = %d", c)
	}
	if c := f.h.Do("GET", "/ci/v1/runs/"+uuid.NewString(), tok.Token, nil).Code; c != http.StatusUnauthorized {
		t.Errorf("revoked token = %d, want 401", c)
	}

	entries, _ := audit.New(f.h.Pool).ListAudit(context.Background(), audit.ListAuditParams{OrganizationID: f.h.OrgID, Limit: 50})
	var created, revoked bool
	for _, e := range entries {
		created = created || e.Action == "token.create"
		revoked = revoked || e.Action == "token.revoke"
	}
	if !created || !revoked {
		t.Errorf("audit created=%v revoked=%v", created, revoked)
	}
}

func TestTokens_Rules(t *testing.T) {
	f := setup(t)
	path := "/api/v1/projects/" + f.w.ProjectID.String() + "/tokens"
	for name, body := range map[string]map[string]any{
		"blank name":    {"name": " "},
		"unknown scope": {"name": "x", "scopes": []string{"admin"}},
	} {
		if c := f.h.Do("POST", path, f.owner, body).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	viewer := f.h.Login("v@x.com", "viewer")
	if c := f.h.Do("POST", path, viewer, map[string]any{"name": "x"}).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
	if c := f.h.Do("POST", "/api/v1/projects/"+uuid.NewString()+"/tokens", f.owner, map[string]any{"name": "x"}).Code; c != http.StatusNotFound {
		t.Errorf("unknown project = %d, want 404", c)
	}
	// a project token is not a user session and vice versa
	tok := f.newToken()
	if c := f.h.Do("GET", path, tok.Token, nil).Code; c != http.StatusUnauthorized {
		t.Errorf("project token on the user API = %d, want 401", c)
	}
	if c := f.h.Do("POST", "/ci/v1/runs", f.owner, map[string]any{"environment": "hml", "type": "exploration"}).Code; c != http.StatusUnauthorized {
		t.Errorf("user session on the CI API = %d, want 401", c)
	}
}

type runResp struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Type    string `json:"type"`
	Trigger string `json:"trigger"`
	Link    string `json:"link"`
}

func TestCI_CreateRunByEnvironmentNameWithTriggerCI(t *testing.T) {
	f := setup(t)
	tok := f.newToken()
	rec := f.h.Do("POST", "/ci/v1/runs", tok.Token, map[string]any{"environment": "hml", "type": "exploration"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var r runResp
	f.h.JSON(rec, &r)
	if r.Status != "queued" || r.Type != "exploration" || r.Trigger != "ci" || r.Link != "https://qa.example/runs/"+r.ID {
		t.Errorf("run = %+v", r)
	}
	var st runResp
	f.h.JSON(f.h.Do("GET", "/ci/v1/runs/"+r.ID, tok.Token, nil), &st)
	if st.ID != r.ID || st.Status != "queued" {
		t.Errorf("status = %+v", st)
	}

	entries, _ := audit.New(f.h.Pool).ListAudit(context.Background(), audit.ListAuditParams{OrganizationID: f.h.OrgID, Limit: 50})
	var actor string
	for _, e := range entries {
		if e.Action == "run.create" {
			actor = e.Actor
		}
	}
	if actor != "token:ci-pipeline" {
		t.Errorf("audit actor = %q, want token:ci-pipeline", actor)
	}

	var lastUsed *time.Time
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT last_used_at FROM api_tokens`).Scan(&lastUsed); err != nil || lastUsed == nil {
		t.Errorf("last_used_at not recorded: %v %v", lastUsed, err)
	}
}

func TestCI_RunRules(t *testing.T) {
	f := setup(t)
	tok := f.newToken()
	post := func(token string, body map[string]any) int { return f.h.Do("POST", "/ci/v1/runs", token, body).Code }

	if c := post(tok.Token, map[string]any{"environment": "nope", "type": "exploration"}); c != http.StatusNotFound {
		t.Errorf("unknown environment = %d, want 404", c)
	}
	if c := post(tok.Token, map[string]any{"environment": "hml", "type": "chaos"}); c != http.StatusBadRequest {
		t.Errorf("bad type = %d, want 400", c)
	}
	if c := post("", map[string]any{"environment": "hml", "type": "exploration"}); c != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", c)
	}
	// regression needs covered nodes: the seeded world has them in a graph
	if c := post(tok.Token, map[string]any{"environment": "hml", "type": "regression"}); c != http.StatusCreated {
		t.Errorf("regression on a covered graph = %d, want 201", c)
	}

	// production never runs
	ctx := context.Background()
	if _, err := environment.New(f.h.Pool).CreateEnvironment(ctx, environment.CreateEnvironmentParams{
		OrganizationID: f.h.OrgID, ProjectID: f.w.ProjectID, Name: "prod", BaseUrl: "https://p.com", AllowedHosts: []string{"p.com"}, DestructivePolicy: "block", IsProduction: true}); err != nil {
		t.Fatal(err)
	}
	if c := post(tok.Token, map[string]any{"environment": "prod", "type": "exploration"}); c != http.StatusConflict {
		t.Errorf("production = %d, want 409", c)
	}

	// scopes are enforced
	readOnly := f.newToken("run:read")
	if c := post(readOnly.Token, map[string]any{"environment": "hml", "type": "exploration"}); c != http.StatusForbidden {
		t.Errorf("read-only token creating a run = %d, want 403", c)
	}
}

func TestCI_ATokenOnlySeesItsOwnProject(t *testing.T) {
	f := setup(t)
	tok := f.newToken()
	// another project with its own environment and run
	ctx := context.Background()
	var otherProject, otherEnv, otherRun uuid.UUID
	pool := f.h.Pool
	_ = pool.QueryRow(ctx, `INSERT INTO projects (organization_id, name) VALUES ($1, 'Other') RETURNING id`, f.h.OrgID).Scan(&otherProject)
	_ = pool.QueryRow(ctx, `INSERT INTO environments (organization_id, project_id, name, base_url, allowed_hosts) VALUES ($1, $2, 'hml', 'https://o.com', '{o.com}') RETURNING id`, f.h.OrgID, otherProject).Scan(&otherEnv)
	_ = pool.QueryRow(ctx, `INSERT INTO runs (organization_id, project_id, environment_id, type, trigger, status) VALUES ($1, $2, $3, 'exploration', 'manual', 'queued') RETURNING id`, f.h.OrgID, otherProject, otherEnv).Scan(&otherRun)

	if c := f.h.Do("GET", "/ci/v1/runs/"+otherRun.String(), tok.Token, nil).Code; c != http.StatusNotFound {
		t.Errorf("other project's run = %d, want 404", c)
	}
	if c := f.h.Do("GET", "/ci/v1/runs/"+otherRun.String()+"/report", tok.Token, nil).Code; c != http.StatusNotFound {
		t.Errorf("other project's report = %d, want 404", c)
	}
}

func TestCI_ReportOfAFinishedRun(t *testing.T) {
	f := setup(t)
	tok := f.newToken()
	run1 := f.w.NewRun("regression", time.Now().Add(-time.Minute), time.Minute)
	f.w.Step(run1, "/orders", "fail", "HTTP 500")
	f.w.Step(run1, "/customers", "pass", "ok")

	var rep struct {
		Run   struct{ Status string } `json:"run"`
		Steps map[string]int          `json:"steps"`
		Reqs  []struct {
			Key         string `json:"key"`
			Criticality string `json:"criticality"`
			Outcome     string `json:"outcome"`
		} `json:"requirements"`
	}
	rec := f.h.Do("GET", "/ci/v1/runs/"+run1.String()+"/report", tok.Token, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("report = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &rep)
	if rep.Steps["fail"] != 1 || rep.Steps["pass"] != 1 || len(rep.Reqs) != 2 {
		t.Errorf("report = %+v", rep)
	}
}
