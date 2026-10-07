package run_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

// Endpoint nodes come from the OpenAPI spec, not from exploration, so a new exploration graph must inherit them
// (with their requirement links) or the API contract would silently stop being tested.
func TestExploration_NewGraphInheritsEndpointNodesAndTheirLinks(t *testing.T) {
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		run.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld() // graph v1: page nodes /orders, /customers, /reports with links
	ctx := context.Background()

	var endpointNode string
	if err := h.Pool.QueryRow(ctx, `INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata)
		VALUES ($1, $2, 'endpoint', 'GET /orders', 'GET /orders', '{api}', '{"operation":{"method":"GET","path":"/orders","status":200}}') RETURNING id::text`, h.OrgID, w.GraphID).Scan(&endpointNode); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 1, 'agent')`, h.OrgID, w.Reqs["REQ-001"], endpointNode); err != nil {
		t.Fatal(err)
	}

	rec := h.Do("POST", "/api/v1/environments/"+w.EnvID.String()+"/runs", owner, map[string]any{"type": "exploration"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var created struct {
		GraphID string `json:"graph_id"`
	}
	h.JSON(rec, &created)
	if created.GraphID == w.GraphID.String() {
		t.Fatal("exploration must create a new graph version")
	}

	count := func(q string, args ...any) int {
		var n int
		if err := h.Pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(`SELECT count(*) FROM nodes WHERE graph_id = $1`, created.GraphID); n != 1 {
		t.Errorf("new graph has %d nodes, want only the inherited endpoint (page nodes come from exploration)", n)
	}
	if n := count(`SELECT count(*) FROM nodes WHERE graph_id = $1 AND kind = 'endpoint' AND fingerprint = 'GET /orders' AND metadata->'operation'->>'status' = '200'`, created.GraphID); n != 1 {
		t.Error("endpoint node (with its contract) was not inherited")
	}
	if n := count(`SELECT count(*) FROM requirement_links l JOIN nodes n ON n.id = l.node_id WHERE n.graph_id = $1 AND l.requirement_id = $2`, created.GraphID, w.Reqs["REQ-001"]); n != 1 {
		t.Errorf("inherited link count = %d, want 1", n)
	}
	// the previous graph is untouched
	if n := count(`SELECT count(*) FROM nodes WHERE graph_id = $1`, w.GraphID); n != 4 {
		t.Errorf("old graph has %d nodes, want 4", n)
	}
}

func TestExploration_FirstGraphHasNothingToInherit(t *testing.T) {
	h, owner, env, _ := setup(t)
	rec := h.Do("POST", "/api/v1/environments/"+env+"/runs", owner, map[string]any{"type": "exploration"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d", rec.Code)
	}
}
