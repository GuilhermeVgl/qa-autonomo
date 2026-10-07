package bug_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/bug"
	"github.com/kpmg/agent-qa/control-plane/internal/knowledge"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fx struct {
	h     *testutil.Harness
	w     *testutil.World
	owner string
	run1  uuid.UUID
}

func setup(t *testing.T) *fx {
	t.Helper()
	f := &fx{}
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		bug.Register(mux, mw, pool)
	})
	f.owner = f.h.Login("o@x.com", "owner")
	f.w = f.h.SeedWorld()
	f.run1 = f.w.NewRun("regression", time.Now().Add(-time.Hour), time.Minute)
	f.w.Step(f.run1, "/orders", "fail", "HTTP 500")
	return f
}

type bugView struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Status      string   `json:"status"`
	Severity    string   `json:"severity"`
	Fingerprint string   `json:"fingerprint"`
	Users       []string `json:"users"`
	Occurrences []struct {
		RunID   string `json:"run_id"`
		RunType string `json:"run_type"`
		Result  string `json:"result"`
		Actual  string `json:"actual"`
	} `json:"occurrences"`
}

func (f *fx) list(query string) []bugView {
	f.h.T.Helper()
	var out []bugView
	rec := f.h.Do("GET", "/api/v1/projects/"+f.w.ProjectID.String()+"/bugs"+query, f.owner, nil)
	if rec.Code != http.StatusOK {
		f.h.T.Fatalf("list = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &out)
	return out
}

func TestListAndGet(t *testing.T) {
	f := setup(t)
	run2 := f.w.NewRun("regression", time.Now(), time.Minute)
	f.w.Step(run2, "/orders", "fail", "HTTP 500") // recurrence
	f.w.Step(run2, "/customers", "error", "net::ERR_TIMED_OUT")

	all := f.list("")
	if len(all) != 2 {
		t.Fatalf("bugs = %+v", all)
	}
	if got := f.list("?status=new"); len(got) != 2 {
		t.Errorf("status filter = %d", len(got))
	}
	if got := f.list("?status=fixed"); len(got) != 0 {
		t.Errorf("status filter fixed = %d", len(got))
	}
	if c := f.h.Do("GET", "/api/v1/projects/"+f.w.ProjectID.String()+"/bugs?status=bogus", f.owner, nil).Code; c != http.StatusBadRequest {
		t.Errorf("bogus status = %d, want 400", c)
	}

	var orders bugView
	for _, b := range all {
		if b.Severity == "critical" {
			orders = b
		}
	}
	var detail bugView
	rec := f.h.Do("GET", "/api/v1/bugs/"+orders.ID, f.owner, nil)
	f.h.JSON(rec, &detail)
	if len(detail.Occurrences) != 2 || detail.Occurrences[0].RunType != "regression" || detail.Occurrences[0].Actual != "HTTP 500" {
		t.Errorf("detail = %+v", detail)
	}
	zero := "00000000-0000-0000-0000-000000000000"
	if c := f.h.Do("GET", "/api/v1/bugs/"+zero, f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("unknown = %d, want 404", c)
	}
	if c := f.h.Do("GET", "/api/v1/bugs/"+orders.ID, "", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("anonymous = %d, want 401", c)
	}
}

func TestStatusTransitions(t *testing.T) {
	f := setup(t)
	id := f.list("")[0].ID
	path := "/api/v1/bugs/" + id + "/status"

	for name, body := range map[string]map[string]any{
		"unknown status":            {"status": "wontfix"},
		"false positive w/o reason": {"status": "false_positive"},
		"blank reason":              {"status": "false_positive", "reason": "  "},
	} {
		if c := f.h.Do("POST", path, f.owner, body).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	if c := f.h.Do("POST", path, f.owner, map[string]any{"status": "reopened"}).Code; c != http.StatusConflict {
		t.Errorf("new -> reopened = %d, want 409", c)
	}
	viewer := f.h.Login("v@x.com", "viewer")
	if c := f.h.Do("POST", path, viewer, map[string]any{"status": "confirmed"}).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}

	var got bugView
	rec := f.h.Do("POST", path, f.owner, map[string]any{"status": "confirmed"})
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &got)
	if got.Status != "confirmed" {
		t.Errorf("status = %s", got.Status)
	}

	entries, _ := audit.New(f.h.Pool).ListAudit(context.Background(), audit.ListAuditParams{OrganizationID: f.h.OrgID, Limit: 50})
	found := false
	for _, e := range entries {
		found = found || e.Action == "bug.status"
	}
	if !found {
		t.Error("bug.status was not audited")
	}
}

func TestFalsePositiveBecomesProjectKnowledge(t *testing.T) {
	f := setup(t)
	id := f.list("")[0].ID
	rec := f.h.Do("POST", "/api/v1/bugs/"+id+"/status", f.owner, map[string]any{"status": "false_positive", "reason": "Tela de erro esperada neste ambiente"})
	if rec.Code != http.StatusOK {
		t.Fatalf("false_positive = %d %s", rec.Code, rec.Body)
	}
	entries, err := knowledge.New(f.h.Pool).ListKnowledge(context.Background(), knowledge.ListKnowledgeParams{OrganizationID: f.h.OrgID, ProjectID: f.w.ProjectID})
	if err != nil || len(entries) != 1 || entries[0].Origin != "false_positive" {
		t.Fatalf("knowledge = %+v, %v", entries, err)
	}
	if want := "Tela de erro esperada neste ambiente"; !contains(entries[0].Content, want) {
		t.Errorf("knowledge content %q should mention the reason", entries[0].Content)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestReproduce_CreatesARegressionRestrictedToTheBugsNode(t *testing.T) {
	f := setup(t)
	id := f.list("")[0].ID
	rec := f.h.Do("POST", "/api/v1/bugs/"+id+"/reproduce", f.owner, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("reproduce = %d %s", rec.Code, rec.Body)
	}
	var created struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}
	f.h.JSON(rec, &created)
	if created.Type != "regression" {
		t.Errorf("run = %+v", created)
	}
	var targets []uuid.UUID
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT target_node_ids FROM runs WHERE id = $1`, created.ID).Scan(&targets); err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0] != f.w.Nodes["/orders"] {
		t.Errorf("target_node_ids = %v, want only /orders", targets)
	}
	viewer := f.h.Login("v@x.com", "viewer")
	if c := f.h.Do("POST", "/api/v1/bugs/"+id+"/reproduce", viewer, nil).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
}

func TestReproduce_FindsTheNodeInANewerGraphByFingerprint(t *testing.T) {
	f := setup(t)
	id := f.list("")[0].ID
	ctx := context.Background()
	// a newer graph version where the same page has a new node id but the same fingerprint, still covered
	var g2 uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO graphs (organization_id, project_id, environment_id, version) VALUES ($1, $2, $3, 2) RETURNING id`, f.h.OrgID, f.w.ProjectID, f.w.EnvID).Scan(&g2); err != nil {
		t.Fatal(err)
	}
	var n2 uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata) VALUES ($1, $2, 'page', 'fp/orders', '/orders', '{admin}', '{"url":"https://a.com/orders"}') RETURNING id`, f.h.OrgID, g2).Scan(&n2); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 1, 'human')`, f.h.OrgID, f.w.Reqs["REQ-001"], n2); err != nil {
		t.Fatal(err)
	}
	rec := f.h.Do("POST", "/api/v1/bugs/"+id+"/reproduce", f.owner, nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("reproduce = %d %s", rec.Code, rec.Body)
	}
	var created struct {
		ID      string `json:"id"`
		GraphID string `json:"graph_id"`
	}
	f.h.JSON(rec, &created)
	var targets []uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `SELECT target_node_ids FROM runs WHERE id = $1`, created.ID).Scan(&targets)
	if len(targets) != 1 || targets[0] != n2 || created.GraphID != g2.String() {
		t.Errorf("targets=%v graph=%s, want node %s in graph %s", targets, created.GraphID, n2, g2)
	}
}

func TestReproduce_ConflictWhenTheNodeIsNoLongerCovered(t *testing.T) {
	f := setup(t)
	id := f.list("")[0].ID
	if _, err := f.h.Pool.Exec(context.Background(), `DELETE FROM requirement_links`); err != nil {
		t.Fatal(err)
	}
	if c := f.h.Do("POST", "/api/v1/bugs/"+id+"/reproduce", f.owner, nil).Code; c != http.StatusConflict {
		t.Errorf("reproduce without coverage = %d, want 409", c)
	}
}

func (f *fx) get(id string) bugView {
	f.h.T.Helper()
	var out bugView
	f.h.JSON(f.h.Do("GET", "/api/v1/bugs/"+id, f.owner, nil), &out)
	return out
}
