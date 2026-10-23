package capability_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/capability"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type capabilityOut struct {
	GraphID      string `json:"graph_id"`
	Capabilities []struct {
		ID           string `json:"id"`
		NodesTotal   int    `json:"nodes_total"`
		NodesCovered int    `json:"nodes_covered"`
		NodesTested  int    `json:"nodes_tested"`
		Status       string `json:"status"`
	} `json:"capabilities"`
}

func setup(t *testing.T) (*testutil.Harness, *testutil.World, string, string) {
	t.Helper()
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		project.Register(mux, mw, pool)
		capability.Register(mux, mw, pool)
	})
	owner := h.Login("owner@x.com", "owner")
	viewer := h.Login("viewer@x.com", "viewer")
	return h, h.SeedWorld(), owner, viewer
}

func TestCapabilities_GroupScreensAndCoverage(t *testing.T) {
	h, w, owner, _ := setup(t)
	rec := h.Do("GET", "/api/v1/environments/"+w.EnvID.String()+"/capabilities", owner, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get capabilities = %d %s", rec.Code, rec.Body.String())
	}
	var out capabilityOut
	h.JSON(rec, &out)
	if out.GraphID != w.GraphID.String() {
		t.Fatalf("graph_id = %s, want %s", out.GraphID, w.GraphID.String())
	}
	if len(out.Capabilities) != 3 {
		t.Fatalf("capabilities = %d, want 3", len(out.Capabilities))
	}
	byID := map[string]struct {
		NodesTotal   int
		NodesCovered int
		NodesTested  int
		Status       string
	}{}
	for _, c := range out.Capabilities {
		byID[c.ID] = struct {
			NodesTotal   int
			NodesCovered int
			NodesTested  int
			Status       string
		}{NodesTotal: c.NodesTotal, NodesCovered: c.NodesCovered, NodesTested: c.NodesTested, Status: c.Status}
	}
	if byID["orders"].NodesCovered != 1 || byID["orders"].NodesTotal != 1 {
		t.Errorf("orders coverage = %d/%d, want 1/1", byID["orders"].NodesCovered, byID["orders"].NodesTotal)
	}
	if byID["reports"].NodesCovered != 0 {
		t.Errorf("reports covered = %d, want 0", byID["reports"].NodesCovered)
	}
	if byID["orders"].Status != "untested" || byID["orders"].NodesTested != 0 {
		t.Errorf("orders status = %s tested=%d, want untested/0", byID["orders"].Status, byID["orders"].NodesTested)
	}
}

func TestCapabilities_UsesLatestNodeStatus(t *testing.T) {
	h, w, owner, _ := setup(t)
	runID := w.NewRun("regression", time.Now().Add(-time.Minute), 15*time.Second)
	w.Step(runID, "/orders", "fail", "HTTP 500")
	w.Step(runID, "/customers", "pass", "ok")

	rec := h.Do("GET", "/api/v1/environments/"+w.EnvID.String()+"/capabilities", owner, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("get capabilities = %d", rec.Code)
	}
	var out capabilityOut
	h.JSON(rec, &out)
	byID := map[string]string{}
	for _, c := range out.Capabilities {
		byID[c.ID] = c.Status
	}
	if byID["orders"] != "fail" {
		t.Errorf("orders status = %s, want fail", byID["orders"])
	}
	if byID["customers"] != "pass" {
		t.Errorf("customers status = %s, want pass", byID["customers"])
	}
}

func TestCapabilities_PostRequiresWriter(t *testing.T) {
	h, w, owner, viewer := setup(t)
	if c := h.Do("POST", "/api/v1/environments/"+w.EnvID.String()+"/capabilities", viewer, map[string]any{}).Code; c != http.StatusForbidden {
		t.Fatalf("viewer post = %d, want 403", c)
	}
	if c := h.Do("POST", "/api/v1/environments/"+w.EnvID.String()+"/capabilities", owner, map[string]any{}).Code; c != http.StatusOK {
		t.Fatalf("owner post = %d, want 200", c)
	}
}

func TestCapabilities_NoGraphIsConflict(t *testing.T) {
	h, w, owner, _ := setup(t)
	ctx := context.Background()
	p, err := project.New(h.Pool).CreateProject(ctx, project.CreateProjectParams{OrganizationID: h.OrgID, Name: "P2"})
	if err != nil {
		t.Fatal(err)
	}
	var envID uuid.UUID
	if err := h.Pool.QueryRow(ctx, `INSERT INTO environments (organization_id, project_id, name, base_url, allowed_hosts, destructive_policy) VALUES ($1, $2, 'empty', 'https://x.com', '{x.com}', 'block') RETURNING id`, h.OrgID, p.ID).Scan(&envID); err != nil {
		t.Fatal(err)
	}
	_ = w
	rec := h.Do("GET", "/api/v1/environments/"+envID.String()+"/capabilities", owner, nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("get without graph = %d, want 409", rec.Code)
	}
}
