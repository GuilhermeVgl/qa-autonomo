package runnerapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/spec"
	"github.com/kpmg/agent-qa/control-plane/internal/step"
)

// ---- artifacts ----

func (f *fx) artifact(token, runID string, body map[string]any) (int, map[string]any) {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/runner/v1/jobs/"+runID+"/artifacts", token, body)
	var out map[string]any
	if rec.Code == http.StatusOK {
		f.h.JSON(rec, &out)
	}
	return rec.Code, out
}

func TestArtifacts_IssuesAScopedPresignedUpload(t *testing.T) {
	store := newMemStore()
	f := setupFull(t, nil, store)
	f.newRun()
	j, _ := f.lease(f.runner)

	code, out := f.artifact(f.runner, j.RunID, map[string]any{"kind": "screenshot", "content_type": "image/png"})
	if code != http.StatusOK {
		t.Fatalf("artifact = %d", code)
	}
	key, _ := out["storage_key"].(string)
	if !strings.HasPrefix(key, f.h.OrgID.String()+"/"+j.RunID+"/") || !strings.HasSuffix(key, ".png") {
		t.Errorf("storage_key = %q, want <org>/<run>/<id>.png", key)
	}
	if url, _ := out["upload_url"].(string); !strings.Contains(url, key) {
		t.Errorf("upload_url = %q", url)
	}
}

func TestArtifacts_Rules(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	runID := f.newRun()
	j, _ := f.lease(f.runner)
	for name, body := range map[string]map[string]any{
		"unknown kind":       {"kind": "malware", "content_type": "image/png"},
		"type not for kind":  {"kind": "screenshot", "content_type": "text/html"},
		"missing type":       {"kind": "screenshot"},
		"html as screenshot": {"kind": "screenshot", "content_type": "text/html; charset=utf-8"},
	} {
		if c, _ := f.artifact(f.runner, j.RunID, body); c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	ok := map[string]any{"kind": "screenshot", "content_type": "image/png"}
	if c, _ := f.artifact(f.runner2, j.RunID, ok); c != http.StatusNotFound {
		t.Errorf("other runner = %d, want 404", c)
	}
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})
	if c, _ := f.artifact(f.runner, runID, ok); c != http.StatusConflict {
		t.Errorf("finished run = %d, want 409", c)
	}

	none := setup(t)
	none.newRun()
	j2, _ := none.lease(none.runner)
	if c, _ := none.artifact(none.runner, j2.RunID, ok); c != http.StatusServiceUnavailable {
		t.Errorf("no storage = %d, want 503", c)
	}
}

// ---- step events ----

func (f *fx) exploreWithNode(store *memStore) (job, string) {
	f.h.T.Helper()
	f.newRun()
	j, _ := f.lease(f.runner)
	f.events(f.runner, j.RunID, ev(1, "node_discovered", map[string]any{
		"fingerprint": "fp-orders", "kind": "page", "label": "/orders", "app_role": "admin",
		"metadata": map[string]any{"status": 200, "url": "https://a.com/orders"},
	}))
	var nodeID string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT id::text FROM nodes WHERE fingerprint = 'fp-orders'`).Scan(&nodeID); err != nil {
		f.h.T.Fatal(err)
	}
	return j, nodeID
}

func (f *fx) steps(runID string) []step.RunStep {
	f.h.T.Helper()
	id, _ := uuid.Parse(runID)
	rows, err := step.New(f.h.Pool).ListStepsByRun(context.Background(), step.ListStepsByRunParams{OrganizationID: f.h.OrgID, RunID: id})
	if err != nil {
		f.h.T.Fatal(err)
	}
	return rows
}

func TestStepEvents_RecordMaskAndMergeStartAndFinish(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j, nodeID := f.exploreWithNode(nil)

	start := ev(2, "step_started", map[string]any{
		"key": "s1", "node_id": nodeID, "executor": "browser", "expected": "status < 400 and same structure",
		"input": map[string]any{"url": "https://a.com/orders", "password": "S3cr3t", "headers": map[string]any{"Authorization": "Bearer x"}},
	})
	finish := ev(3, "step_finished", map[string]any{"key": "s1", "result": "pass", "actual": "status 200, structure unchanged"})
	if c := f.events(f.runner, j.RunID, start, finish); c != http.StatusOK {
		t.Fatalf("events = %d", c)
	}
	if c := f.events(f.runner, j.RunID, start, finish); c != http.StatusOK { // retry of the same batch
		t.Fatalf("resend = %d", c)
	}
	steps := f.steps(j.RunID)
	if len(steps) != 1 {
		t.Fatalf("steps = %d, want 1", len(steps))
	}
	s := steps[0]
	if s.Result == nil || *s.Result != "pass" || s.Expected != "status < 400 and same structure" || s.Actual == "" || !s.StartedAt.Valid || !s.FinishedAt.Valid {
		t.Errorf("step = %+v", s)
	}
	if strings.Contains(string(s.InputMasked), "S3cr3t") || strings.Contains(string(s.InputMasked), "Bearer x") || !strings.Contains(string(s.InputMasked), "https://a.com/orders") {
		t.Errorf("input not masked correctly: %s", s.InputMasked)
	}
}

func TestStepEvents_FinishBeforeStartStillMerges(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j, nodeID := f.exploreWithNode(nil)
	finish := ev(2, "step_finished", map[string]any{"key": "s1", "result": "fail", "actual": "status 500"})
	start := ev(3, "step_started", map[string]any{"key": "s1", "node_id": nodeID, "executor": "browser", "expected": "ok", "input": map[string]any{}})
	if c := f.events(f.runner, j.RunID, finish, start); c != http.StatusOK {
		t.Fatalf("events = %d", c)
	}
	steps := f.steps(j.RunID)
	if len(steps) != 1 || steps[0].Result == nil || *steps[0].Result != "fail" || steps[0].Expected != "ok" || !steps[0].NodeID.Valid {
		t.Errorf("steps = %+v", steps)
	}
}

func TestStepEvents_Validation(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j, nodeID := f.exploreWithNode(nil)
	zero := "00000000-0000-0000-0000-000000000000"
	for name, e := range map[string]map[string]any{
		"no key":             ev(2, "step_started", map[string]any{"node_id": nodeID, "executor": "browser", "expected": "x", "input": map[string]any{}}),
		"bad executor":       ev(2, "step_started", map[string]any{"key": "k", "node_id": nodeID, "executor": "vr", "expected": "x", "input": map[string]any{}}),
		"unknown node":       ev(2, "step_started", map[string]any{"key": "k", "node_id": zero, "executor": "browser", "expected": "x", "input": map[string]any{}}),
		"bad node id":        ev(2, "step_started", map[string]any{"key": "k", "node_id": "nope", "executor": "browser", "expected": "x", "input": map[string]any{}}),
		"bad result":         ev(2, "step_finished", map[string]any{"key": "k", "result": "maybe", "actual": "x"}),
		"input not object":   ev(2, "step_started", map[string]any{"key": "k", "node_id": nodeID, "executor": "browser", "expected": "x", "input": "str"}),
		"finish without key": ev(2, "step_finished", map[string]any{"result": "pass", "actual": "x"}),
	} {
		if c := f.events(f.runner, j.RunID, e); c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	if n := len(f.steps(j.RunID)); n != 0 {
		t.Errorf("rejected events stored %d steps", n)
	}
}

func TestStepEvents_NodeOfAnotherRunsGraphIsRejected(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j1, foreignNode := f.exploreWithNode(nil) // belongs to the first exploration's graph
	f.h.Do("POST", "/runner/v1/jobs/"+j1.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})

	f.newRun() // a new exploration creates a NEW graph version
	j2, c := f.lease(f.runner)
	if c != http.StatusOK || j2.GraphID == j1.GraphID {
		t.Fatalf("second lease = %d graph %s (first %s)", c, j2.GraphID, j1.GraphID)
	}
	e := ev(1, "step_started", map[string]any{"key": "k", "node_id": foreignNode, "executor": "browser", "expected": "x", "input": map[string]any{}})
	if code := f.events(f.runner, j2.RunID, e); code != http.StatusBadRequest {
		t.Errorf("node of another graph = %d, want 400", code)
	}
}

func TestStepEvents_ArtifactsAreVerifiedAgainstStorage(t *testing.T) {
	store := newMemStore()
	f := setupFull(t, nil, store)
	j, nodeID := f.exploreWithNode(store)
	prefix := f.h.OrgID.String() + "/" + j.RunID + "/"
	store.objects[prefix+"a.png"] = []byte("PNG")

	base := func(seq int, key string, arts ...map[string]any) map[string]any {
		return ev(seq, "step_finished", map[string]any{"key": key, "result": "fail", "actual": "x", "artifacts": arts})
	}
	f.events(f.runner, j.RunID, ev(2, "step_started", map[string]any{"key": "s1", "node_id": nodeID, "executor": "browser", "expected": "x", "input": map[string]any{}}))

	art := func(key string) map[string]any {
		return map[string]any{"kind": "screenshot", "storage_key": key, "content_type": "image/png"}
	}
	if c := f.events(f.runner, j.RunID, base(3, "s1", art(prefix+"a.png"))); c != http.StatusOK {
		t.Fatalf("valid artifact = %d", c)
	}
	var size int64
	var kind string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT size, kind FROM artifacts`).Scan(&size, &kind); err != nil || size != 3 || kind != "screenshot" {
		t.Errorf("artifact row size=%d kind=%q err=%v (size must come from storage)", size, kind, err)
	}

	for name, key := range map[string]string{
		"other run prefix": f.h.OrgID.String() + "/" + uuid.NewString() + "/a.png",
		"other org prefix": uuid.NewString() + "/" + j.RunID + "/a.png",
		"path traversal":   prefix + "../x.png",
		"never uploaded":   prefix + "ghost.png",
	} {
		if c := f.events(f.runner, j.RunID, base(10, "s2", art(key))); c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}

	// oversized objects are rejected and removed from storage
	store.objects[prefix+"huge.png"] = make([]byte, 21<<20)
	if c := f.events(f.runner, j.RunID, base(11, "s3", art(prefix+"huge.png"))); c != http.StatusBadRequest {
		t.Errorf("oversized = %d, want 400", c)
	}
	if _, still := store.objects[prefix+"huge.png"]; still {
		t.Error("oversized object was not deleted")
	}
}

func TestStepEvents_ArtifactsNeedStorage(t *testing.T) {
	f := setup(t) // no storage
	j, nodeID := f.exploreWithNode(nil)
	f.events(f.runner, j.RunID, ev(2, "step_started", map[string]any{"key": "s1", "node_id": nodeID, "executor": "browser", "expected": "x", "input": map[string]any{}}))
	e := ev(3, "step_finished", map[string]any{"key": "s1", "result": "pass", "actual": "x",
		"artifacts": []map[string]any{{"kind": "screenshot", "storage_key": "a/b.png", "content_type": "image/png"}}})
	if c := f.events(f.runner, j.RunID, e); c != http.StatusServiceUnavailable {
		t.Errorf("artifacts without storage = %d, want 503", c)
	}
}

// ---- regression jobs ----

func TestRegressionJob_TargetsCoveredNodesOfTheExistingGraph(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j, nodeID := f.exploreWithNode(nil)
	f.events(f.runner, j.RunID, ev(2, "node_discovered", map[string]any{"fingerprint": "fp-other", "kind": "page", "label": "/other", "app_role": "admin", "metadata": map[string]any{"url": "https://a.com/other"}}))
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})
	f.dropAutoSpec()

	// before any requirement is linked there is nothing to test
	if c := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "regression"}).Code; c != http.StatusConflict {
		t.Fatalf("regression without covered nodes = %d, want 409", c)
	}

	// link REQ-001 -> /orders (the other node stays uncovered)
	ctx := context.Background()
	var projectID uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `SELECT project_id FROM environments WHERE id = $1`, f.envID).Scan(&projectID)
	sp, err := spec.New(f.h.Pool).CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: f.h.OrgID, ProjectID: projectID, Version: 1, SourceType: "text", Title: "v1", ExtractedText: "t"})
	if err != nil {
		t.Fatal(err)
	}
	rq, err := spec.New(f.h.Pool).CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: f.h.OrgID, SpecID: sp.ID, Key: "REQ-001", Text: "x", Criticality: "critical", Status: "new"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 0.9, 'agent')`, f.h.OrgID, rq.ID, nodeID); err != nil {
		t.Fatal(err)
	}

	var created struct {
		ID      string `json:"id"`
		GraphID string `json:"graph_id"`
		Type    string `json:"type"`
	}
	rec := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "regression"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create regression = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &created)
	if created.GraphID != j.GraphID {
		t.Errorf("regression must reuse the latest graph %s, got %s", j.GraphID, created.GraphID)
	}

	rec = f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", f.runner, nil)
	var lj struct {
		RunID   string `json:"run_id"`
		Type    string `json:"type"`
		Targets []struct {
			NodeID          string   `json:"node_id"`
			Fingerprint     string   `json:"fingerprint"`
			URL             string   `json:"url"`
			Label           string   `json:"label"`
			AppRole         string   `json:"app_role"`
			RequirementKeys []string `json:"requirement_keys"`
		} `json:"targets"`
	}
	f.h.JSON(rec, &lj)
	if lj.Type != "regression" || len(lj.Targets) != 1 {
		t.Fatalf("job = %+v", lj)
	}
	tg := lj.Targets[0]
	if tg.NodeID != nodeID || tg.Fingerprint != "fp-orders" || tg.URL != "https://a.com/orders" || tg.AppRole != "admin" || len(tg.RequirementKeys) != 1 || tg.RequirementKeys[0] != "REQ-001" {
		t.Errorf("target = %+v", tg)
	}

	// steps of a regression may reference the reused graph's nodes
	e := ev(1, "step_started", map[string]any{"key": "k", "node_id": nodeID, "executor": "browser", "expected": "x", "input": map[string]any{}})
	if c := f.events(f.runner, lj.RunID, e); c != http.StatusOK {
		t.Errorf("step on reused graph = %d, want 200", c)
	}
}

// ---- bugs from regression steps ----

// regress creates a regression run, executes one step on the node with the given outcome and completes it.
func (f *fx) regress(nodeID, result, actual string) string {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "regression"})
	if rec.Code != http.StatusCreated {
		f.h.T.Fatalf("create regression = %d %s", rec.Code, rec.Body)
	}
	j, c := f.lease(f.runner)
	if c != http.StatusOK {
		f.h.T.Fatalf("lease = %d", c)
	}
	events := []map[string]any{
		ev(1, "step_started", map[string]any{"key": nodeID, "node_id": nodeID, "executor": "browser", "expected": "HTTP < 400", "input": map[string]any{}}),
		ev(2, "step_finished", map[string]any{"key": nodeID, "result": result, "actual": actual}),
	}
	if code := f.events(f.runner, j.RunID, events...); code != http.StatusOK {
		f.h.T.Fatalf("events = %d", code)
	}
	if code := f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}}).Code; code != http.StatusOK {
		f.h.T.Fatalf("complete = %d", code)
	}
	return j.RunID
}

// linkedNode explores one node and links it to a requirement of the given criticality.
// dropAutoSpec removes the automatic spec that completing an exploration writes, for tests about user-written specs.
func (f *fx) dropAutoSpec() {
	f.h.T.Helper()
	ctx := context.Background()
	for _, q := range []string{
		`DELETE FROM requirement_links WHERE requirement_id IN (SELECT r.id FROM requirements r JOIN specs s ON s.id = r.spec_id WHERE s.source_type = 'auto')`,
		`DELETE FROM pendencies WHERE requirement_id IN (SELECT r.id FROM requirements r JOIN specs s ON s.id = r.spec_id WHERE s.source_type = 'auto')`,
		`DELETE FROM requirements WHERE spec_id IN (SELECT id FROM specs WHERE source_type = 'auto')`,
		`DELETE FROM specs WHERE source_type = 'auto'`,
	} {
		if _, err := f.h.Pool.Exec(ctx, q); err != nil {
			f.h.T.Fatal(err)
		}
	}
}

func (f *fx) linkedNode(key, criticality string) string {
	f.h.T.Helper()
	j, nodeID := f.exploreWithNode(nil)
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})
	f.dropAutoSpec()
	ctx := context.Background()
	var projectID uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `SELECT project_id FROM environments WHERE id = $1`, f.envID).Scan(&projectID)
	sp, err := spec.New(f.h.Pool).CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: f.h.OrgID, ProjectID: projectID, Version: 1, SourceType: "text", Title: "v1", ExtractedText: "t"})
	if err != nil {
		f.h.T.Fatal(err)
	}
	rq, err := spec.New(f.h.Pool).CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: f.h.OrgID, SpecID: sp.ID, Key: key, Text: "x", Criticality: criticality, Status: "new"})
	if err != nil {
		f.h.T.Fatal(err)
	}
	if _, err := f.h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 0.9, 'agent')`, f.h.OrgID, rq.ID, nodeID); err != nil {
		f.h.T.Fatal(err)
	}
	return nodeID
}

type bugRow struct {
	Status, Severity, Title string
	Occurrences             int
	FirstSeen, LastSeen     string
	FixedIn                 *string
}

func (f *fx) bugs() []bugRow {
	f.h.T.Helper()
	rows, err := f.h.Pool.Query(context.Background(), `
		SELECT b.status, b.severity, b.title, (SELECT count(*) FROM bug_occurrences o WHERE o.bug_id = b.id),
		       b.first_seen_run_id::text, b.last_seen_run_id::text, b.fixed_in_run_id::text
		FROM bugs b ORDER BY b.created_at`)
	if err != nil {
		f.h.T.Fatal(err)
	}
	defer rows.Close()
	var out []bugRow
	for rows.Next() {
		var b bugRow
		if err := rows.Scan(&b.Status, &b.Severity, &b.Title, &b.Occurrences, &b.FirstSeen, &b.LastSeen, &b.FixedIn); err != nil {
			f.h.T.Fatal(err)
		}
		out = append(out, b)
	}
	return out
}

func TestBugs_LifecycleFromRegressionSteps(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	node := f.linkedNode("REQ-001", "critical")

	run1 := f.regress(node, "fail", "HTTP 500")
	bugs := f.bugs()
	if len(bugs) != 1 {
		t.Fatalf("bugs after first failure = %+v", bugs)
	}
	b := bugs[0]
	if b.Status != "new" || b.Severity != "critical" || b.Occurrences != 1 || b.FirstSeen != run1 || b.LastSeen != run1 {
		t.Errorf("new bug = %+v", b)
	}
	for _, want := range []string{"REQ-001", "/orders", "HTTP 500"} {
		if !strings.Contains(b.Title, want) {
			t.Errorf("title %q should mention %q", b.Title, want)
		}
	}

	// the same failure again is the same bug, even if noise in the message changes
	run2 := f.regress(node, "fail", "HTTP 500")
	bugs = f.bugs()
	if len(bugs) != 1 || bugs[0].Occurrences != 2 || bugs[0].LastSeen != run2 || bugs[0].FirstSeen != run1 || bugs[0].Status != "new" {
		t.Errorf("recurring = %+v", bugs)
	}

	// a different failure on the same node is a different bug
	f.regress(node, "error", "net::ERR_TIMED_OUT after 15000ms")
	if n := len(f.bugs()); n != 2 {
		t.Errorf("distinct failure should open another bug, have %d", n)
	}

	// a passing run fixes the bugs of the node that did not occur in it
	run4 := f.regress(node, "pass", "HTTP 200, structure unchanged")
	for _, b := range f.bugs() {
		if b.Status != "fixed" || b.FixedIn == nil || *b.FixedIn != run4 {
			t.Errorf("after a passing run: %+v", b)
		}
	}

	// failing again reopens it and clears the fix
	f.regress(node, "fail", "HTTP 500")
	reopened := 0
	for _, b := range f.bugs() {
		if b.Status == "reopened" {
			reopened++
			if b.FixedIn != nil {
				t.Errorf("reopened bug still marked fixed in %s", *b.FixedIn)
			}
		}
	}
	if reopened != 1 {
		t.Errorf("reopened = %d, want 1", reopened)
	}
}

func TestBugs_FalsePositiveStaysFalsePositiveWhenItRecurs(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	node := f.linkedNode("REQ-001", "normal")
	f.regress(node, "fail", "HTTP 500")
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE bugs SET status = 'false_positive'`); err != nil {
		t.Fatal(err)
	}
	f.regress(node, "fail", "HTTP 500")
	bugs := f.bugs()
	if len(bugs) != 1 || bugs[0].Status != "false_positive" || bugs[0].Occurrences != 2 || bugs[0].Severity != "normal" {
		t.Errorf("bugs = %+v", bugs)
	}
	// and a pass does not "fix" something a human classified as noise
	f.regress(node, "pass", "ok")
	if got := f.bugs()[0].Status; got != "false_positive" {
		t.Errorf("status after pass = %s, want false_positive", got)
	}
}

func TestBugs_SkippedStepsNeitherOpenNorFix(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	node := f.linkedNode("REQ-001", "high")
	f.regress(node, "fail", "HTTP 500")
	f.regress(node, "skipped", "outside the allowed hosts")
	bugs := f.bugs()
	if len(bugs) != 1 || bugs[0].Status != "new" {
		t.Errorf("a skipped step must not change bugs: %+v", bugs)
	}
}

// ---- API (endpoint) targets ----

func TestRegressionJob_EndpointTargetsCarryTheContract(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	pageNode := f.linkedNode("REQ-001", "critical") // the explored page, covered
	ctx := context.Background()

	var graphID, specID uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `SELECT graph_id FROM nodes WHERE id = $1`, pageNode).Scan(&graphID); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Pool.QueryRow(ctx, `SELECT id FROM specs ORDER BY created_at DESC LIMIT 1`).Scan(&specID); err != nil {
		t.Fatal(err)
	}
	rq, err := spec.New(f.h.Pool).CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: f.h.OrgID, SpecID: specID, Key: "GET /orders/{id}", Text: "contrato", Criticality: "normal", Status: "new"})
	if err != nil {
		t.Fatal(err)
	}
	var endpointID uuid.UUID
	meta := `{"operation":{"method":"GET","path":"/orders/{id}","status":200,"schema":{"type":"object","required":["id"]},
		"path_params":[{"name":"id","in":"path","required":true,"example":"42"}],"query":[{"name":"page","in":"query","required":true,"example":"1"}]}}`
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata)
		VALUES ($1, $2, 'endpoint', 'GET /orders/{id}', 'GET /orders/{id}', '{api}', $3) RETURNING id`, f.h.OrgID, graphID, meta).Scan(&endpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 1, 'agent')`, f.h.OrgID, rq.ID, endpointID); err != nil {
		t.Fatal(err)
	}

	if c := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "regression"}).Code; c != http.StatusCreated {
		t.Fatalf("create regression = %d", c)
	}
	rec := f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", f.runner, nil)
	var job struct {
		Targets []struct {
			Kind         string         `json:"kind"`
			NodeID       string         `json:"node_id"`
			Method       string         `json:"method"`
			Path         string         `json:"path"`
			Query        map[string]any `json:"query"`
			Status       int            `json:"status"`
			Schema       map[string]any `json:"schema"`
			BodyRequired bool           `json:"body_required"`
			URL          string         `json:"url"`
		} `json:"targets"`
	}
	f.h.JSON(rec, &job)
	if len(job.Targets) != 2 {
		t.Fatalf("targets = %+v", job.Targets)
	}
	var api, page int
	for _, tg := range job.Targets {
		switch tg.Kind {
		case "endpoint":
			api++
			if tg.NodeID != endpointID.String() || tg.Method != "GET" || tg.Path != "/orders/42" || tg.Status != 200 || tg.Schema["type"] != "object" || tg.Query["page"] != "1" {
				t.Errorf("endpoint target = %+v", tg)
			}
		case "page":
			page++
			if tg.URL == "" {
				t.Errorf("page target lost its url: %+v", tg)
			}
		default:
			t.Errorf("unknown kind %q", tg.Kind)
		}
	}
	if api != 1 || page != 1 {
		t.Errorf("api=%d page=%d, want 1 and 1", api, page)
	}
}

func TestLease_JobCarriesTheEnvironmentDevice(t *testing.T) {
	f := setup(t)
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE environments SET device = 'Pixel 7' WHERE id = $1`, f.envID); err != nil {
		t.Fatal(err)
	}
	f.newRun()
	j, c := f.lease(f.runner)
	if c != http.StatusOK || j.Environment.Device != "Pixel 7" {
		t.Errorf("lease = %d device = %q, want Pixel 7", c, j.Environment.Device)
	}
}

// ---- terminal environments ----

func (f *fx) registerWithLabels(name string, labels ...string) string {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/runner/v1/register", "", map[string]any{"bootstrap_token": bootstrap, "name": name, "labels": labels, "version": "0.0.1"})
	if rec.Code != http.StatusOK {
		f.h.T.Fatalf("register = %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Token string `json:"token"`
	}
	f.h.JSON(rec, &out)
	return out.Token
}

func TestTerminalRuns_AreOnlyLeasedToRunnersWithTheRightLabels(t *testing.T) {
	f := setup(t)
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE environments SET kind = 'terminal', terminal_binary = 'samplecli', terminal_image = 'registry.local/samplecli:1' WHERE id = $1`, f.envID); err != nil {
		t.Fatal(err)
	}
	rec := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "exploration"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var labels []string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT required_labels FROM runs`).Scan(&labels); err != nil || len(labels) != 2 {
		t.Fatalf("required_labels = %v (%v), want terminal + image", labels, err)
	}

	// a plain browser runner must not receive a terminal job, and neither one with only half of the labels
	if _, c := f.lease(f.runner); c != http.StatusNoContent {
		t.Errorf("browser runner lease = %d, want 204", c)
	}
	onlyTerminal := f.registerWithLabels("t1", "terminal")
	if _, c := f.lease(onlyTerminal); c != http.StatusNoContent {
		t.Errorf("runner without the image label = %d, want 204", c)
	}
	wrongImage := f.registerWithLabels("t2", "terminal", "image:registry.local/other:9")
	if _, c := f.lease(wrongImage); c != http.StatusNoContent {
		t.Errorf("runner with another image = %d, want 204", c)
	}

	right := f.registerWithLabels("t3", "terminal", "image:registry.local/samplecli:1")
	rec = f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", right, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("matching runner lease = %d", rec.Code)
	}
	var job struct {
		Environment struct {
			Kind     string `json:"kind"`
			Terminal *struct {
				Binary string `json:"binary"`
				Image  string `json:"image"`
			} `json:"terminal"`
		} `json:"environment"`
	}
	f.h.JSON(rec, &job)
	if job.Environment.Kind != "terminal" || job.Environment.Terminal == nil || job.Environment.Terminal.Binary != "samplecli" || job.Environment.Terminal.Image != "registry.local/samplecli:1" {
		t.Errorf("job environment = %+v", job.Environment)
	}
}

func TestWebRuns_StillGoToAnyRunner(t *testing.T) {
	f := setup(t)
	f.newRun()
	bare := f.registerWithLabels("no-labels")
	if _, c := f.lease(bare); c != http.StatusOK {
		t.Errorf("a runner with no labels must still get web runs, got %d", c)
	}
}

func TestRegressionJob_CommandTargetsCarryTheArgsAndHelpSignature(t *testing.T) {
	f := setup(t)
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE environments SET kind = 'terminal', terminal_binary = 'samplecli' WHERE id = $1`, f.envID); err != nil {
		t.Fatal(err)
	}
	runner := f.registerWithLabels("t", "terminal")
	f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "exploration"})
	rec := f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", runner, nil)
	var j job
	f.h.JSON(rec, &j)
	meta := `{"command":{"args":["orders","list"],"help_signature":"abc123"}}`
	var nodeID uuid.UUID
	if err := f.h.Pool.QueryRow(context.Background(), `INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata)
		VALUES ($1, $2, 'command', 'samplecli orders list', 'samplecli orders list', '{cli}', $3) RETURNING id`, f.h.OrgID, j.GraphID, meta).Scan(&nodeID); err != nil {
		t.Fatal(err)
	}
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})
	var projectID, specID, reqID uuid.UUID
	ctx := context.Background()
	_ = f.h.Pool.QueryRow(ctx, `SELECT project_id FROM environments WHERE id = $1`, f.envID).Scan(&projectID)
	sp, err := spec.New(f.h.Pool).CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: f.h.OrgID, ProjectID: projectID, Version: 1, SourceType: "text", Title: "v1", ExtractedText: "t"})
	if err != nil {
		t.Fatal(err)
	}
	specID = sp.ID
	rq, err := spec.New(f.h.Pool).CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: f.h.OrgID, SpecID: specID, Key: "REQ-CLI-1", Text: "lista pedidos", Criticality: "high", Status: "new"})
	if err != nil {
		t.Fatal(err)
	}
	reqID = rq.ID
	if _, err := f.h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 1, 'agent')`, f.h.OrgID, reqID, nodeID); err != nil {
		t.Fatal(err)
	}

	if c := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "regression"}).Code; c != http.StatusCreated {
		t.Fatalf("regression = %d", c)
	}
	rec = f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", runner, nil)
	var out struct {
		Targets []struct {
			Kind          string   `json:"kind"`
			Args          []string `json:"args"`
			HelpSignature string   `json:"help_signature"`
			NodeID        string   `json:"node_id"`
		} `json:"targets"`
	}
	f.h.JSON(rec, &out)
	if len(out.Targets) != 1 || out.Targets[0].Kind != "command" || len(out.Targets[0].Args) != 2 || out.Targets[0].Args[1] != "list" || out.Targets[0].HelpSignature != "abc123" {
		t.Errorf("targets = %+v", out.Targets)
	}
}

func TestRegressionJob_LimitedToOneSpecOnlyTestsItsNodesAndKeys(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j, ordersID := f.exploreWithNode(nil)
	f.events(f.runner, j.RunID, ev(2, "node_discovered", map[string]any{"fingerprint": "fp-other", "kind": "page", "label": "/other", "app_role": "admin", "metadata": map[string]any{"url": "https://a.com/other"}}))
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})
	f.dropAutoSpec()

	ctx := context.Background()
	var projectID, otherID uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `SELECT project_id FROM environments WHERE id = $1`, f.envID).Scan(&projectID)
	_ = f.h.Pool.QueryRow(ctx, `SELECT id FROM nodes WHERE graph_id = $1 AND label = '/other'`, j.GraphID).Scan(&otherID)
	mkSpec := func(version int32, title, key string, node any) uuid.UUID {
		sp, err := spec.New(f.h.Pool).CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: f.h.OrgID, ProjectID: projectID, Version: version, SourceType: "text", Title: title, ExtractedText: "t"})
		if err != nil {
			t.Fatal(err)
		}
		rq, err := spec.New(f.h.Pool).CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: f.h.OrgID, SpecID: sp.ID, Key: key, Text: "x", Criticality: "high", Status: "new"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 0.9, 'agent')`, f.h.OrgID, rq.ID, node); err != nil {
			t.Fatal(err)
		}
		return sp.ID
	}
	specA := mkSpec(1, "A", "REQ-001", ordersID)
	specB := mkSpec(2, "B", "REQ-009", otherID)
	// both specs also cover /orders, so the keys of the other spec must not leak into the job
	_ = mkSpec(3, "C", "REQ-777", ordersID)

	lease := func(specID uuid.UUID) (labels, keys []string) {
		rec := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "regression", "spec_id": specID})
		if rec.Code != http.StatusCreated {
			t.Fatalf("regression for spec = %d %s", rec.Code, rec.Body)
		}
		var created struct {
			ID     string         `json:"id"`
			Budget map[string]any `json:"budget"`
		}
		f.h.JSON(rec, &created)
		if created.Budget["spec_id"] != specID.String() {
			t.Errorf("budget scope = %v, want %s", created.Budget["spec_id"], specID)
		}
		rec = f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", f.runner, nil)
		var lj struct {
			RunID   string `json:"run_id"`
			Targets []struct {
				Label           string   `json:"label"`
				RequirementKeys []string `json:"requirement_keys"`
			} `json:"targets"`
		}
		f.h.JSON(rec, &lj)
		for _, tg := range lj.Targets {
			labels = append(labels, tg.Label)
			keys = append(keys, tg.RequirementKeys...)
		}
		f.h.Do("POST", "/runner/v1/jobs/"+lj.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})
		return labels, keys
	}

	labels, keys := lease(specB)
	if len(labels) != 1 || labels[0] != "/other" || len(keys) != 1 || keys[0] != "REQ-009" {
		t.Errorf("spec B job: labels=%v keys=%v, want only /other with REQ-009", labels, keys)
	}
	labels, keys = lease(specA)
	if len(labels) != 1 || labels[0] != "/orders" || len(keys) != 1 || keys[0] != "REQ-001" {
		t.Errorf("spec A job: labels=%v keys=%v, want only /orders with REQ-001", labels, keys)
	}
}

func TestComplete_ExplorationWritesTheAutomaticSpecAndRegressionCanUseIt(t *testing.T) {
	f := setupFull(t, nil, newMemStore())
	j, _ := f.exploreWithNode(nil)
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})

	var title string
	var reqs, links int
	ctx := context.Background()
	if err := f.h.Pool.QueryRow(ctx, `SELECT s.title, (SELECT count(*) FROM requirements WHERE spec_id = s.id),
		(SELECT count(*) FROM requirement_links l JOIN requirements r ON r.id = l.requirement_id WHERE r.spec_id = s.id)
		FROM specs s WHERE s.source_type = 'auto'`).Scan(&title, &reqs, &links); err != nil {
		t.Fatalf("no automatic spec after the exploration: %v", err)
	}
	if title != "Varredura automática · hml" || reqs != 1 || links != 1 {
		t.Errorf("auto spec = %q with %d requirements and %d links, want 1 requirement for the explored page", title, reqs, links)
	}
	// the page is covered by the default spec, so a regression is possible without writing any spec by hand
	if c := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "regression"}).Code; c != http.StatusCreated {
		t.Errorf("regression on the automatic spec = %d, want 201", c)
	}
}

func TestNodeThumbnail_AttachesAVerifiedScreenshotToTheNode(t *testing.T) {
	store := newMemStore()
	f := setupFull(t, nil, store)
	j, nodeID := f.exploreWithNode(store)
	prefix := f.h.OrgID.String() + "/" + j.RunID + "/"
	store.objects[prefix+"orders.jpg"] = []byte("JPEG")
	thumb := func(seq int, fp, key, kind, ct string) int {
		return f.events(f.runner, j.RunID, ev(seq, "node_thumbnail", map[string]any{"fingerprint": fp, "artifact": map[string]any{"kind": kind, "storage_key": key, "content_type": ct}}))
	}

	if c := thumb(2, "fp-orders", prefix+"orders.jpg", "screenshot", "image/jpeg"); c != http.StatusOK {
		t.Fatalf("valid thumbnail = %d", c)
	}
	var key, ct string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT thumbnail_key, thumbnail_content_type FROM nodes WHERE id = $1`, nodeID).Scan(&key, &ct); err != nil || key != prefix+"orders.jpg" || ct != "image/jpeg" {
		t.Errorf("node thumbnail = %q %q err=%v", key, ct, err)
	}
	nodes, _ := f.graphOf(j)
	if len(nodes) == 0 || nodes[0]["has_thumbnail"] != true {
		t.Errorf("the graph does not say the node has a thumbnail: %v", nodes)
	}

	for name, c := range map[string]int{
		"unknown screen":       thumb(3, "fp-nope", prefix+"orders.jpg", "screenshot", "image/jpeg"),
		"a key of another run": thumb(4, "fp-orders", f.h.OrgID.String()+"/"+uuid.NewString()+"/x.jpg", "screenshot", "image/jpeg"),
		"never uploaded":       thumb(5, "fp-orders", prefix+"ghost.jpg", "screenshot", "image/jpeg"),
		"not an image":         thumb(6, "fp-orders", prefix+"orders.jpg", "http", "application/json"),
		"path traversal":       thumb(7, "fp-orders", prefix+"../x.jpg", "screenshot", "image/jpeg"),
	} {
		if c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
}

func TestNodeThumbnail_NeedsStorage(t *testing.T) {
	f := setup(t) // no storage
	j, _ := f.exploreWithNode(nil)
	e := ev(2, "node_thumbnail", map[string]any{"fingerprint": "fp-orders", "artifact": map[string]any{"kind": "screenshot", "storage_key": "a/b.jpg", "content_type": "image/jpeg"}})
	if c := f.events(f.runner, j.RunID, e); c != http.StatusServiceUnavailable {
		t.Errorf("thumbnail without storage = %d, want 503", c)
	}
}
