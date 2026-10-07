package bug_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/bug"
)

// failAs records a failure of a route as one user's node, the way the runner API does for each finished step.
func (f *fx) failAs(t *testing.T, runID uuid.UUID, label, nodeFingerprint, role, actual string) {
	t.Helper()
	ctx := context.Background()
	var nodeID uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `SELECT id FROM nodes WHERE graph_id = $1 AND fingerprint = $2`, f.w.GraphID, nodeFingerprint).Scan(&nodeID); err != nil {
		if err := f.h.Pool.QueryRow(ctx, `INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata) VALUES ($1, $2, 'page', $3, $4, ARRAY[$5]::text[], '{}') RETURNING id`, f.h.OrgID, f.w.GraphID, nodeFingerprint, label, role).Scan(&nodeID); err != nil {
			t.Fatal(err)
		}
	}
	var stepID uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO run_steps (organization_id, run_id, client_key, node_id, executor, result, actual) VALUES ($1, $2, $3, $4, 'browser', 'fail', $5) RETURNING id`, f.h.OrgID, runID, uuid.NewString(), nodeID, actual).Scan(&stepID); err != nil {
		t.Fatal(err)
	}
	if err := bug.Record(ctx, bug.New(f.h.Pool), bug.RecordInput{
		OrganizationID: f.h.OrgID, ProjectID: f.w.ProjectID, RunID: runID, StepID: stepID, NodeID: nodeID,
		NodeFingerprint: nodeFingerprint, NodeLabel: label, Result: "fail", Actual: actual,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestRecord_TheSameRouteFailingTheSameWayForTwoUsersIsOneBug(t *testing.T) {
	f := setup(t) // /orders already failed once as the admin: "HTTP 500"
	run2 := f.w.NewRun("regression", time.Now().Add(-30*time.Minute), time.Minute)
	f.failAs(t, run2, "/orders", "fp/orders/operador", "operador", "HTTP 500 (falhou nas 2 tentativas)")

	bugs := f.list("")
	if len(bugs) != 1 {
		t.Fatalf("bugs = %d (%+v), want the defect once whoever hits it", len(bugs), bugs)
	}
	got := f.get(bugs[0].ID)
	if len(got.Occurrences) != 2 {
		t.Errorf("occurrences = %d, want one per user's failure", len(got.Occurrences))
	}
	if len(bugs[0].Users) != 2 || bugs[0].Users[0] != "admin" || bugs[0].Users[1] != "operador" {
		t.Errorf("users = %v, want who it affects: admin and operador", bugs[0].Users)
	}
}

func TestRecord_DifferentErrorsOnTheSameRouteStayDifferentBugs(t *testing.T) {
	f := setup(t)
	run2 := f.w.NewRun("regression", time.Now().Add(-30*time.Minute), time.Minute)
	f.failAs(t, run2, "/orders", "fp/orders/operador", "operador", "HTTP 403")
	if n := len(f.list("")); n != 2 {
		t.Errorf("bugs = %d, want 2: a 500 and a 403 are not the same defect", n)
	}
}

func TestRecord_AnOldBugIsFoundByItsOldFingerprintAndKeepsItsHistory(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	q := bug.New(f.h.Pool)
	// a bug recorded before bugs were deduplicated across users: its fingerprint was made from the user's node
	old, err := q.CreateBug(ctx, bug.CreateBugParams{
		OrganizationID: f.h.OrgID, ProjectID: f.w.ProjectID, Fingerprint: bug.Fingerprint("fp/customers", "REQ-002", "HTTP 404"), Title: "REQ-002 · /customers: HTTP 404",
		Severity: "high", NodeID: uuid.NullUUID{UUID: f.w.Nodes["/customers"], Valid: true}, NodeFingerprint: "fp/customers", FirstSeenRunID: f.run1,
	})
	if err != nil {
		t.Fatal(err)
	}
	run2 := f.w.NewRun("regression", time.Now().Add(-30*time.Minute), time.Minute)
	f.w.Step(run2, "/customers", "fail", "HTTP 404")
	// and the operator hits the same defect: it joins the same bug instead of opening a second one
	f.failAs(t, run2, "/customers", "fp/customers/operador", "operador", "HTTP 404")

	var n int
	if err := f.h.Pool.QueryRow(ctx, `SELECT count(*) FROM bugs WHERE project_id = $1 AND title LIKE '%/customers%'`, f.w.ProjectID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("customers bugs = %d err=%v, want the old one reused", n, err)
	}
	var fp string
	if err := f.h.Pool.QueryRow(ctx, `SELECT fingerprint FROM bugs WHERE id = $1`, old.ID).Scan(&fp); err != nil {
		t.Fatal(err)
	}
	if fp != bug.RouteFingerprint("/customers", "REQ-002", "HTTP 404") {
		t.Errorf("the old bug was not moved to the new fingerprint: %q", fp)
	}
	if got := f.get(old.ID.String()); len(got.Occurrences) != 2 {
		t.Errorf("occurrences = %d, want 2 (admin and operador)", len(got.Occurrences))
	}
}
