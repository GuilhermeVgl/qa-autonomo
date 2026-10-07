package spec_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type reqRow struct {
	Quality     []string `json:"quality"`
	ID          string   `json:"id"`
	Key         string   `json:"key"`
	Text        string   `json:"text"`
	Criticality string   `json:"criticality"`
	Status      string   `json:"status"`
}

func manageSetup(t *testing.T) (h *testutil.Harness, owner string, w *testutil.World) {
	t.Helper()
	h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		spec.Register(mux, mw, pool, nil)
	})
	owner = h.Login("o@x.com", "owner")
	return h, owner, h.SeedWorld() // spec "v1": REQ-001 -> /orders, REQ-002 -> /customers
}

func (r reqRow) path() string { return "/api/v1/requirements/" + r.ID }

func listReqs(t *testing.T, h *testutil.Harness, owner string, specID uuid.UUID) []reqRow {
	t.Helper()
	var out []reqRow
	h.JSON(h.Do("GET", "/api/v1/specs/"+specID.String()+"/requirements", owner, nil), &out)
	return out
}

func TestRequirementsAreListedWithTheirIDs(t *testing.T) {
	h, owner, w := manageSetup(t)
	rows := listReqs(t, h, owner, w.SpecID)
	if len(rows) != 2 || rows[0].ID == "" {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestRenameSpec(t *testing.T) {
	h, owner, w := manageSetup(t)
	path := "/api/v1/specs/" + w.SpecID.String()
	rec := h.Do("PATCH", path, owner, map[string]string{"title": "  Cobrança v2  "})
	if rec.Code != http.StatusOK {
		t.Fatalf("rename = %d %s", rec.Code, rec.Body)
	}
	var got struct {
		Title   string `json:"title"`
		Version int    `json:"version"`
	}
	h.JSON(rec, &got)
	if got.Title != "Cobrança v2" || got.Version != 1 {
		t.Errorf("got = %+v", got)
	}
	for name, body := range map[string]map[string]string{"empty": {"title": " "}, "too long": {"title": string(make([]byte, 300))}} {
		if c := h.Do("PATCH", path, owner, body).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	viewer := h.Login("v@x.com", "viewer")
	if c := h.Do("PATCH", path, viewer, map[string]string{"title": "x"}).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
	if c := h.Do("PATCH", "/api/v1/specs/"+uuid.NewString(), owner, map[string]string{"title": "x"}).Code; c != http.StatusNotFound {
		t.Errorf("unknown spec = %d, want 404", c)
	}
	entries, _ := audit.New(h.Pool).ListAudit(context.Background(), audit.ListAuditParams{OrganizationID: h.OrgID, Limit: 20})
	found := false
	for _, e := range entries {
		found = found || e.Action == "spec.update"
	}
	if !found {
		t.Error("renaming must be audited (spec.update)")
	}
}

func TestEditARequirementMarksItChanged(t *testing.T) {
	h, owner, w := manageSetup(t)
	req := listReqs(t, h, owner, w.SpecID)[0]
	rec := h.Do("PATCH", req.path(), owner, map[string]string{"text": " Pedidos aparecem em ordem de data ", "criticality": "normal"})
	if rec.Code != http.StatusOK {
		t.Fatalf("edit = %d %s", rec.Code, rec.Body)
	}
	var got reqRow
	h.JSON(rec, &got)
	if got.Text != "Pedidos aparecem em ordem de data" || got.Criticality != "normal" || got.Status != "changed" || got.Key != req.Key {
		t.Errorf("got = %+v (key must stay %s)", got, req.Key)
	}
	// only what was sent changes
	rec = h.Do("PATCH", req.path(), owner, map[string]string{"criticality": "critical"})
	h.JSON(rec, &got)
	if got.Text != "Pedidos aparecem em ordem de data" || got.Criticality != "critical" {
		t.Errorf("partial edit = %+v", got)
	}
	for name, body := range map[string]map[string]string{"empty text": {"text": " "}, "bad criticality": {"criticality": "urgent"}, "nothing": {}} {
		if c := h.Do("PATCH", req.path(), owner, body).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	if c := h.Do("PATCH", "/api/v1/requirements/"+uuid.NewString(), owner, map[string]string{"text": "x"}).Code; c != http.StatusNotFound {
		t.Errorf("unknown requirement = %d, want 404", c)
	}
}

func TestAddARequirementGetsTheNextKey(t *testing.T) {
	h, owner, w := manageSetup(t)
	path := "/api/v1/specs/" + w.SpecID.String() + "/requirements"
	rec := h.Do("POST", path, owner, map[string]string{"text": "Exportar pedidos em CSV", "criticality": "high"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("add = %d %s", rec.Code, rec.Body)
	}
	var got reqRow
	h.JSON(rec, &got)
	if got.Key != "REQ-003" || got.Status != "new" || got.Criticality != "high" {
		t.Errorf("got = %+v, want REQ-003 after REQ-001 and REQ-002", got)
	}
	if c := h.Do("POST", path, owner, map[string]string{"text": " ", "criticality": "high"}).Code; c != http.StatusBadRequest {
		t.Errorf("empty text = %d, want 400", c)
	}
	if c := h.Do("POST", path, owner, map[string]string{"text": "x", "criticality": "meh"}).Code; c != http.StatusBadRequest {
		t.Errorf("bad criticality = %d, want 400", c)
	}
}

func TestDeleteARequirementClearsWhatDependsOnItButKeepsBugHistory(t *testing.T) {
	h, owner, w := manageSetup(t)
	ctx := context.Background()
	runID := w.NewRun("regression", time.Now(), 0)
	w.Step(runID, "/orders", "fail", "HTTP 500") // a bug linked to REQ-001
	if _, err := h.Pool.Exec(ctx, `INSERT INTO pendencies (organization_id, requirement_id, question) VALUES ($1, $2, 'q?')`, h.OrgID, w.Reqs["REQ-001"]); err != nil {
		t.Fatal(err)
	}

	req := reqRow{ID: w.Reqs["REQ-001"].String()}
	if c := h.Do("DELETE", req.path(), owner, nil).Code; c != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", c)
	}
	count := func(q string, args ...any) int {
		var n int
		if err := h.Pool.QueryRow(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := count(`SELECT count(*) FROM requirements WHERE id = $1`, w.Reqs["REQ-001"]); n != 0 {
		t.Error("requirement still there")
	}
	if n := count(`SELECT count(*) FROM requirement_links WHERE requirement_id = $1`, w.Reqs["REQ-001"]); n != 0 {
		t.Error("links must go with the requirement")
	}
	if n := count(`SELECT count(*) FROM pendencies WHERE requirement_id = $1`, w.Reqs["REQ-001"]); n != 0 {
		t.Error("pendencies must go with the requirement")
	}
	if n := count(`SELECT count(*) FROM bugs WHERE requirement_id IS NULL AND project_id = $1`, w.ProjectID); n != 1 {
		t.Errorf("the bug must stay, only detached from the requirement (got %d detached bugs)", n)
	}
	if n := len(listReqs(t, h, owner, w.SpecID)); n != 1 {
		t.Errorf("requirements left = %d, want 1", n)
	}
	if c := h.Do("DELETE", req.path(), owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("delete again = %d, want 404", c)
	}
}

func TestDeleteASpecRemovesItsRequirementsLinksAndPendencies(t *testing.T) {
	h, owner, w := manageSetup(t)
	ctx := context.Background()
	runID := w.NewRun("regression", time.Now(), 0)
	w.Step(runID, "/customers", "fail", "HTTP 404")
	if c := h.Do("DELETE", "/api/v1/specs/"+w.SpecID.String(), owner, nil).Code; c != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", c)
	}
	for table, q := range map[string]string{
		"specs":             `SELECT count(*) FROM specs WHERE project_id = $1`,
		"requirements":      `SELECT count(*) FROM requirements WHERE organization_id = $1`,
		"requirement_links": `SELECT count(*) FROM requirement_links WHERE organization_id = $1`,
	} {
		arg := any(w.ProjectID)
		if table != "specs" {
			arg = h.OrgID
		}
		var n int
		if err := h.Pool.QueryRow(ctx, q, arg).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s left = %d (%v), want 0", table, n, err)
		}
	}
	var bugs int
	_ = h.Pool.QueryRow(ctx, `SELECT count(*) FROM bugs WHERE project_id = $1`, w.ProjectID).Scan(&bugs)
	if bugs != 1 {
		t.Errorf("bugs = %d: deleting a spec must not delete the defects found", bugs)
	}
	// the graph and its nodes belong to the environment, not to the spec
	var nodes int
	_ = h.Pool.QueryRow(ctx, `SELECT count(*) FROM nodes WHERE graph_id = $1`, w.GraphID).Scan(&nodes)
	if nodes != 3 {
		t.Errorf("nodes = %d, want 3", nodes)
	}
	viewer := h.Login("v@x.com", "viewer")
	if c := h.Do("DELETE", "/api/v1/specs/"+uuid.NewString(), viewer, nil).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
	if c := h.Do("DELETE", "/api/v1/specs/"+w.SpecID.String(), owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("delete again = %d, want 404", c)
	}
}

func TestRequirementsCarryQualityFlagsForWrittenRequirementsOnly(t *testing.T) {
	h, owner, w := manageSetup(t)
	ctx := context.Background()
	add := func(key, text string) {
		if _, err := spec.New(h.Pool).CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: h.OrgID, SpecID: w.SpecID, Key: key, Text: text, Criticality: "normal", Status: "new"}); err != nil {
			t.Fatal(err)
		}
	}
	add("REQ-003", "O sistema deve ser rápido e amigável.")
	add("REQ-004", "REQ-002 text") // very close to the seeded REQ-002 "REQ-002 text"
	add("PAGE /x", "x")            // generated: not judged
	got := map[string]reqRow{}
	for _, r := range listReqs(t, h, owner, w.SpecID) {
		got[r.Key] = r
	}
	if q := got["REQ-003"].Quality; len(q) != 1 || q[0] != "vago" {
		t.Errorf("REQ-003 quality = %v, want [vago]", q)
	}
	if q := got["REQ-004"].Quality; len(q) == 0 || q[len(q)-1] != "parecido com REQ-002" {
		t.Errorf("REQ-004 quality = %v, want to be flagged as close to REQ-002", q)
	}
	if q := got["PAGE /x"].Quality; len(q) != 0 {
		t.Errorf("a generated requirement is not judged, got %v", q)
	}
	if got["REQ-001"].Quality == nil {
		t.Error("quality must be a list (empty when fine), never null")
	}
}
