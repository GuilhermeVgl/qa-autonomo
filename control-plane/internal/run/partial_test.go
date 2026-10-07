package run_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

func partialHarness(t *testing.T) (*testutil.Harness, string, *testutil.World) {
	t.Helper()
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		run.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld() // /orders, /customers, /reports belong to "admin"
	for _, role := range []string{"admin", "operador"} {
		if _, err := environment.New(h.Pool).UpsertCredential(context.Background(), environment.UpsertCredentialParams{OrganizationID: h.OrgID, EnvironmentID: w.EnvID, AppRole: role, Kind: "login", PayloadEncrypted: []byte("x")}); err != nil {
			t.Fatal(err)
		}
	}
	return h, owner, w
}

func count(t *testing.T, h *testutil.Harness, q string, args ...any) int {
	t.Helper()
	var n int
	if err := h.Pool.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Exploring one user makes a new graph version, but the screens of the users who were not explored must come along:
// otherwise mapping the operator would wipe the admin's map, its pictures and what was linked to it.
func TestExploration_OfSomeUsersKeepsTheMapOfTheOthers(t *testing.T) {
	h, owner, w := partialHarness(t)
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := h.Pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	// the operator's own screen in the old graph, and a picture of an admin screen
	exec(`INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata) VALUES ($1, $2, 'page', 'fp-ops', '/ops', '{operador}', '{}')`, h.OrgID, w.GraphID)
	exec(`UPDATE nodes SET thumbnail_key = 'k/orders.jpg', thumbnail_content_type = 'image/jpeg' WHERE id = $1`, w.Nodes["/orders"])
	// an edge between two admin screens, and one from an admin screen to the operator's
	exec(`INSERT INTO edges (organization_id, graph_id, from_node_id, to_node_id, key, action, app_roles) VALUES ($1, $2, $3, $4, 'link /customers', '{}', '{admin}')`, h.OrgID, w.GraphID, w.Nodes["/orders"], w.Nodes["/customers"])
	exec(`INSERT INTO edges (organization_id, graph_id, from_node_id, to_node_id, key, action, app_roles) VALUES ($1, $2, $3, (SELECT id FROM nodes WHERE graph_id = $2 AND fingerprint = 'fp-ops'), 'link /ops', '{}', '{operador}')`, h.OrgID, w.GraphID, w.Nodes["/orders"])

	rec := h.Do("POST", "/api/v1/environments/"+w.EnvID.String()+"/runs", owner, map[string]any{"type": "exploration", "budget": map[string]any{"roles": []string{"operador"}}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var created struct {
		GraphID string         `json:"graph_id"`
		Budget  map[string]any `json:"budget"`
	}
	h.JSON(rec, &created)
	if created.GraphID == w.GraphID.String() {
		t.Fatal("a partial exploration still makes a new graph version")
	}
	if got, _ := created.Budget["roles"].([]any); len(got) != 1 || got[0] != "operador" {
		t.Errorf("budget.roles = %v, want [operador] (the run says who was explored)", created.Budget["roles"])
	}

	if n := count(t, h, `SELECT count(*) FROM nodes WHERE graph_id = $1 AND 'admin' = ANY(app_roles)`, created.GraphID); n != 3 {
		t.Errorf("admin screens in the new graph = %d, want 3 (not explored this time, so kept)", n)
	}
	if n := count(t, h, `SELECT count(*) FROM nodes WHERE graph_id = $1 AND 'operador' = ANY(app_roles)`, created.GraphID); n != 0 {
		t.Errorf("operador screens in the new graph = %d, want 0 (to be explored again, and anything gone from the app must go)", n)
	}
	if n := count(t, h, `SELECT count(*) FROM nodes WHERE graph_id = $1 AND thumbnail_key = 'k/orders.jpg' AND thumbnail_content_type = 'image/jpeg'`, created.GraphID); n != 1 {
		t.Error("the picture of a kept screen was not carried over")
	}
	if n := count(t, h, `SELECT count(*) FROM edges WHERE graph_id = $1 AND key = 'link /customers'`, created.GraphID); n != 1 {
		t.Error("the link between two kept screens was not carried over")
	}
	if n := count(t, h, `SELECT count(*) FROM edges WHERE graph_id = $1 AND key = 'link /ops'`, created.GraphID); n != 0 {
		t.Error("a link of the explored user must not be carried over")
	}
	if n := count(t, h, `SELECT count(*) FROM requirement_links l JOIN nodes n ON n.id = l.node_id WHERE n.graph_id = $1`, created.GraphID); n != 2 {
		t.Errorf("requirement links in the new graph = %d, want the 2 of the kept screens", n)
	}
	// the previous graph is untouched
	if n := count(t, h, `SELECT count(*) FROM nodes WHERE graph_id = $1`, w.GraphID); n != 4 {
		t.Errorf("old graph has %d nodes, want 4", n)
	}
}

func TestExploration_UsersMustExistAndAllUsersMeansACompleteMap(t *testing.T) {
	h, owner, w := partialHarness(t)
	path := "/api/v1/environments/" + w.EnvID.String() + "/runs"
	if c := h.Do("POST", path, owner, map[string]any{"type": "exploration", "budget": map[string]any{"roles": []string{"fantasma"}}}).Code; c != http.StatusBadRequest {
		t.Errorf("unknown user = %d, want 400", c)
	}
	// no users chosen: every user is explored and nothing is carried over (a clean new map)
	rec := h.Do("POST", path, owner, map[string]any{"type": "exploration"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d", rec.Code)
	}
	var created struct {
		GraphID string `json:"graph_id"`
	}
	h.JSON(rec, &created)
	if n := count(t, h, `SELECT count(*) FROM nodes WHERE graph_id = $1`, created.GraphID); n != 0 {
		t.Errorf("a complete exploration carried %d screens over, want 0", n)
	}
}

// An exploration that stopped early (cancelled, failed, out of time or pages) can be continued: the new run works on the
// same graph, so nothing found so far is lost and the runner can skip what it already examined.
func TestExploration_ResumeContinuesOnTheSameGraph(t *testing.T) {
	h, owner, w := partialHarness(t)
	ctx := context.Background()
	path := "/api/v1/environments/" + w.EnvID.String() + "/runs"
	resume := map[string]any{"type": "exploration", "budget": map[string]any{"resume": true}}

	// nothing to continue yet: the graph has no exploration run (it was seeded by hand)
	if c := h.Do("POST", path, owner, resume).Code; c != http.StatusConflict {
		t.Errorf("resume without an exploration = %d, want 409", c)
	}

	first := w.NewRun("exploration", time.Now(), 0) // finished 'succeeded' with an empty summary
	set := func(status, summary string) {
		t.Helper()
		if _, err := h.Pool.Exec(ctx, `UPDATE runs SET status = $2, summary = $3::jsonb WHERE id = $1`, first, status, summary); err != nil {
			t.Fatal(err)
		}
	}
	set("succeeded", `{"stopped_by":"exhausted"}`)
	if c := h.Do("POST", path, owner, resume).Code; c != http.StatusConflict {
		t.Errorf("resume of a complete exploration = %d, want 409 (nothing left to explore)", c)
	}

	for name, st := range map[string][2]string{
		"cancelled":     {"cancelled", `{}`},
		"failed":        {"failed", `{"error":"x"}`},
		"out of pages":  {"succeeded", `{"stopped_by":"max_pages"}`},
		"out of time":   {"succeeded", `{"stopped_by":"max_seconds"}`},
		"cancelled sum": {"succeeded", `{"stopped_by":"cancelled"}`},
	} {
		set(st[0], st[1])
		rec := h.Do("POST", path, owner, resume)
		if rec.Code != http.StatusCreated {
			t.Fatalf("%s: resume = %d %s", name, rec.Code, rec.Body)
		}
		var created struct {
			ID      string `json:"id"`
			GraphID string `json:"graph_id"`
		}
		h.JSON(rec, &created)
		if created.GraphID != w.GraphID.String() {
			t.Errorf("%s: resumed on graph %s, want the same graph %s", name, created.GraphID, w.GraphID)
		}
		if n := count(t, h, `SELECT count(*) FROM graphs WHERE environment_id = $1`, w.EnvID); n != 1 {
			t.Errorf("%s: %d graphs, want still 1", name, n)
		}
		if n := count(t, h, `SELECT count(*) FROM nodes WHERE graph_id = $1`, w.GraphID); n != 3 {
			t.Errorf("%s: the graph has %d nodes, want the 3 it had", name, n)
		}
		if _, err := h.Pool.Exec(ctx, `DELETE FROM runs WHERE id = $1`, created.ID); err != nil { // the next case judges the first run again
			t.Fatal(err)
		}
	}
}

func TestExploration_ResumeRules(t *testing.T) {
	h, owner, w := partialHarness(t)
	path := "/api/v1/environments/" + w.EnvID.String() + "/runs"
	first := w.NewRun("exploration", time.Now(), 0)
	if _, err := h.Pool.Exec(context.Background(), `UPDATE runs SET status = 'cancelled' WHERE id = $1`, first); err != nil {
		t.Fatal(err)
	}
	// resuming only makes sense for an exploration
	if c := h.Do("POST", path, owner, map[string]any{"type": "regression", "budget": map[string]any{"resume": true}}).Code; c != http.StatusBadRequest {
		t.Errorf("resume on a regression = %d, want 400", c)
	}
	// resume can be limited to some users like any exploration, still on the same graph
	rec := h.Do("POST", path, owner, map[string]any{"type": "exploration", "budget": map[string]any{"resume": true, "roles": []string{"operador"}}})
	if rec.Code != http.StatusCreated {
		t.Fatalf("resume as operador = %d %s", rec.Code, rec.Body)
	}
	var created struct {
		GraphID string `json:"graph_id"`
	}
	h.JSON(rec, &created)
	if created.GraphID != w.GraphID.String() {
		t.Error("a resume limited to a user must still reuse the graph")
	}
}

// Security checks are part of every run; turning them off is a choice of the person, kept on the run for the report.
func TestCreateRun_SecurityChecksCanBeTurnedOff(t *testing.T) {
	h, owner, w := partialHarness(t)
	path := "/api/v1/environments/" + w.EnvID.String() + "/runs"
	for name, body := range map[string]map[string]any{
		"default": {"type": "exploration"},
		"off":     {"type": "exploration", "budget": map[string]any{"no_security": true}},
	} {
		rec := h.Do("POST", path, owner, body)
		if rec.Code != http.StatusCreated {
			t.Fatalf("%s = %d %s", name, rec.Code, rec.Body)
		}
		var created struct {
			ID     string         `json:"id"`
			Budget map[string]any `json:"budget"`
		}
		h.JSON(rec, &created)
		got, present := created.Budget["no_security"]
		if (name == "off") != (present && got == true) {
			t.Errorf("%s: budget.no_security = %v (present %v)", name, got, present)
		}
		if _, err := h.Pool.Exec(context.Background(), `UPDATE runs SET status = 'cancelled' WHERE id = $1`, created.ID); err != nil {
			t.Fatal(err)
		}
	}
}
