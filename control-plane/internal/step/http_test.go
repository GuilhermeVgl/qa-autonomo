package step_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/step"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type memStore struct{ objects map[string][]byte }

func (m *memStore) EnsureBucket(context.Context) error { return nil }
func (m *memStore) Put(_ context.Context, k string, r io.Reader, _ int64, _ string) error {
	b, _ := io.ReadAll(r)
	m.objects[k] = b
	return nil
}
func (m *memStore) Get(_ context.Context, k string) (io.ReadCloser, error) {
	b, ok := m.objects[k]
	if !ok {
		return nil, io.ErrUnexpectedEOF
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}
func (m *memStore) Size(_ context.Context, k string) (int64, error) {
	return int64(len(m.objects[k])), nil
}
func (m *memStore) Delete(_ context.Context, k string) error { delete(m.objects, k); return nil }
func (m *memStore) PresignPut(context.Context, string, time.Duration) (string, error) {
	return "", nil
}

type fx struct {
	h      *testutil.Harness
	owner  string
	store  *memStore
	nodeID uuid.UUID
	runIDs []uuid.UUID
}

func setup(t *testing.T, withStore bool) *fx {
	t.Helper()
	f := &fx{store: &memStore{objects: map[string][]byte{}}}
	var st step.Storage
	if withStore {
		st = f.store
	}
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		step.Register(mux, mw, pool, st)
	})
	f.owner = f.h.Login("o@x.com", "owner")
	ctx, org, pool := context.Background(), f.h.OrgID, f.h.Pool
	p, err := project.New(pool).CreateProject(ctx, project.CreateProjectParams{OrganizationID: org, Name: "P"})
	must(t, err)
	e, err := environment.New(pool).CreateEnvironment(ctx, environment.CreateEnvironmentParams{
		OrganizationID: org, ProjectID: p.ID, Name: "hml", BaseUrl: "https://a.com", AllowedHosts: []string{"a.com"}, DestructivePolicy: "block"})
	must(t, err)
	g, err := graph.New(pool).CreateGraph(ctx, graph.CreateGraphParams{OrganizationID: org, ProjectID: p.ID, EnvironmentID: e.ID, Version: 1})
	must(t, err)
	n, err := graph.New(pool).UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: org, GraphID: g.ID, Kind: "page", Fingerprint: "fp", Label: "/orders", AppRoles: []string{"admin"}, Metadata: []byte(`{}`)})
	must(t, err)
	f.nodeID = n.ID
	for i := 0; i < 2; i++ {
		r, err := run.New(pool).CreateRun(ctx, run.CreateRunParams{
			OrganizationID: org, ProjectID: p.ID, EnvironmentID: e.ID, GraphID: uuid.NullUUID{UUID: g.ID, Valid: true},
			Type: "regression", Trigger: "manual", Budget: []byte(`{}`)})
		must(t, err)
		f.runIDs = append(f.runIDs, r.ID)
	}
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (f *fx) addStep(runID uuid.UUID, key, result string) step.RunStep {
	f.h.T.Helper()
	now := time.Now()
	r := result
	s, err := step.New(f.h.Pool).UpsertStep(context.Background(), step.UpsertStepParams{
		OrganizationID: f.h.OrgID, RunID: runID, ClientKey: key, NodeID: uuid.NullUUID{UUID: f.nodeID, Valid: true}, Executor: strPtr("browser"),
		InputMasked: []byte(`{"url":"https://a.com/orders"}`), Expected: "status < 400", Actual: "status 200", Result: &r,
		StartedAt: pgTime(now), FinishedAt: pgTime(now.Add(time.Second)),
	})
	must(f.h.T, err)
	return s
}

func (f *fx) addArtifact(s step.RunStep, key string, data []byte) step.Artifact {
	f.h.T.Helper()
	f.store.objects[key] = data
	a, err := step.New(f.h.Pool).CreateArtifact(context.Background(), step.CreateArtifactParams{
		OrganizationID: f.h.OrgID, RunStepID: s.ID, Kind: "screenshot", StorageKey: key, ContentType: "image/png", Size: int64(len(data))})
	must(f.h.T, err)
	return a
}

type historyItem struct {
	RunID     string `json:"run_id"`
	RunType   string `json:"run_type"`
	Result    string `json:"result"`
	Expected  string `json:"expected"`
	Actual    string `json:"actual"`
	User      string `json:"user"`
	Artifacts []struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
		Size int64  `json:"size"`
	} `json:"artifacts"`
}

func TestNodeHistory_ListsStepsAcrossRunsNewestFirstWithArtifacts(t *testing.T) {
	f := setup(t, true)
	f.addStep(f.runIDs[0], "s1", "pass")
	s2 := f.addStep(f.runIDs[1], "s1", "fail")
	f.addArtifact(s2, "org/run/shot.png", []byte("PNG"))

	var out []historyItem
	rec := f.h.Do("GET", "/api/v1/nodes/"+f.nodeID.String()+"/history", f.owner, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("history = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &out)
	if len(out) != 2 || out[0].Result != "fail" || out[1].Result != "pass" || out[0].RunType != "regression" {
		t.Fatalf("history = %+v", out)
	}
	if len(out[0].Artifacts) != 1 || out[0].Artifacts[0].Kind != "screenshot" || out[0].Artifacts[0].Size != 3 || len(out[1].Artifacts) != 0 {
		t.Errorf("artifacts = %+v / %+v", out[0].Artifacts, out[1].Artifacts)
	}
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE nodes SET app_roles = '{operador}' WHERE id = $1`, f.nodeID); err != nil {
		t.Fatal(err)
	}
	var again []historyItem
	f.h.JSON(f.h.Do("GET", "/api/v1/nodes/"+f.nodeID.String()+"/history", f.owner, nil), &again)
	if len(again) == 0 || again[0].User != "operador" {
		t.Errorf("user of the step = %+v, want the node's user (operador): the run must say who was tested", again)
	}
	if out[0].Expected != "status < 400" || out[0].Actual != "status 200" {
		t.Errorf("expected/actual = %q/%q", out[0].Expected, out[0].Actual)
	}
}

func TestRunSteps(t *testing.T) {
	f := setup(t, true)
	f.addStep(f.runIDs[0], "a", "pass")
	f.addStep(f.runIDs[0], "b", "fail")
	var out []historyItem
	f.h.JSON(f.h.Do("GET", "/api/v1/runs/"+f.runIDs[0].String()+"/steps", f.owner, nil), &out)
	if len(out) != 2 {
		t.Fatalf("steps = %+v", out)
	}
	var none []historyItem
	f.h.JSON(f.h.Do("GET", "/api/v1/runs/"+f.runIDs[1].String()+"/steps", f.owner, nil), &none)
	if len(none) != 0 {
		t.Errorf("other run leaked steps: %+v", none)
	}
}

func TestHistory_NotFoundAndAuth(t *testing.T) {
	f := setup(t, true)
	zero := "00000000-0000-0000-0000-000000000000"
	if c := f.h.Do("GET", "/api/v1/nodes/"+zero+"/history", f.owner, nil).Code; c != http.StatusOK { // unknown node: empty history, not an error
		t.Errorf("unknown node = %d", c)
	}
	if c := f.h.Do("GET", "/api/v1/nodes/nope/history", f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("bad id = %d, want 404", c)
	}
	if c := f.h.Do("GET", "/api/v1/nodes/"+f.nodeID.String()+"/history", "", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("anonymous = %d, want 401", c)
	}
}

func TestArtifactContent_StreamsWithSafeHeaders(t *testing.T) {
	f := setup(t, true)
	s := f.addStep(f.runIDs[0], "a", "fail")
	a := f.addArtifact(s, "org/run/x.png", []byte("PNGDATA"))
	rec := f.h.Do("GET", "/api/v1/artifacts/"+a.ID.String()+"/content", f.owner, nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "PNGDATA" {
		t.Fatalf("content = %d %q", rec.Code, rec.Body)
	}
	h := rec.Header()
	if h.Get("Content-Type") != "image/png" || h.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(h.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("headers = %v", h)
	}
	zero := "00000000-0000-0000-0000-000000000000"
	if c := f.h.Do("GET", "/api/v1/artifacts/"+zero+"/content", f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("unknown artifact = %d, want 404", c)
	}
	if c := f.h.Do("GET", "/api/v1/artifacts/"+a.ID.String()+"/content", "", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("anonymous = %d, want 401", c)
	}
}

func TestArtifactContent_WithoutStorage(t *testing.T) {
	f := setup(t, false)
	s := f.addStep(f.runIDs[0], "a", "fail")
	a := f.addArtifact(s, "k", []byte("x"))
	if c := f.h.Do("GET", "/api/v1/artifacts/"+a.ID.String()+"/content", f.owner, nil).Code; c != http.StatusServiceUnavailable {
		t.Errorf("no storage = %d, want 503", c)
	}
}

func pgTime(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func strPtr(s string) *string { return &s }

func TestNodeThumbnail_ServedThroughTheAPIAndOnlyWhenTheNodeHasOne(t *testing.T) {
	f := setup(t, true)
	ctx := context.Background()
	path := "/api/v1/nodes/" + f.nodeID.String() + "/thumbnail"

	if c := f.h.Do("GET", path, f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("a node without a thumbnail = %d, want 404", c)
	}
	f.store.objects["org/run/shot.jpg"] = []byte("JPEGDATA")
	if _, err := f.h.Pool.Exec(ctx, `UPDATE nodes SET thumbnail_key = 'org/run/shot.jpg', thumbnail_content_type = 'image/jpeg' WHERE id = $1`, f.nodeID); err != nil {
		t.Fatal(err)
	}
	rec := f.h.Do("GET", path, f.owner, nil)
	if rec.Code != http.StatusOK || rec.Body.String() != "JPEGDATA" {
		t.Fatalf("thumbnail = %d %q", rec.Code, rec.Body)
	}
	// it comes from the tested app: never interpreted as a page
	if rec.Header().Get("Content-Type") != "image/jpeg" || rec.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("headers = %v", rec.Header())
	}
	if c := f.h.Do("GET", "/api/v1/nodes/"+uuid.NewString()+"/thumbnail", f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("unknown node = %d, want 404", c)
	}
	delete(f.store.objects, "org/run/shot.jpg")
	if c := f.h.Do("GET", path, f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("an object that is gone = %d, want 404", c)
	}
}

func TestNodeThumbnail_NeedsStorage(t *testing.T) {
	f := setup(t, false)
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE nodes SET thumbnail_key = 'a/b.jpg', thumbnail_content_type = 'image/jpeg' WHERE id = $1`, f.nodeID); err != nil {
		t.Fatal(err)
	}
	if c := f.h.Do("GET", "/api/v1/nodes/"+f.nodeID.String()+"/thumbnail", f.owner, nil).Code; c != http.StatusServiceUnavailable {
		t.Errorf("without storage = %d, want 503", c)
	}
}

// pagedFixture adds nodes of two users and steps of every result to the first run.
func (f *fx) pagedFixture(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	var graphID uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `SELECT graph_id FROM nodes WHERE id = $1`, f.nodeID).Scan(&graphID); err != nil {
		t.Fatal(err)
	}
	mk := func(label, role string) uuid.UUID {
		var id uuid.UUID
		if err := f.h.Pool.QueryRow(ctx, `INSERT INTO nodes (organization_id, graph_id, kind, fingerprint, label, app_roles, metadata) VALUES ($1, $2, 'page', $3, $4, ARRAY[$5]::text[], '{}') RETURNING id`, f.h.OrgID, graphID, label+role, label, role).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	admin, operator := mk("/a", "admin"), mk("/b", "operador")
	add := func(node uuid.UUID, key, result string) {
		if _, err := f.h.Pool.Exec(ctx, `INSERT INTO run_steps (organization_id, run_id, client_key, node_id, executor, result) VALUES ($1, $2, $3, $4, 'browser', NULLIF($5, ''))`, f.h.OrgID, f.runIDs[0], key, node, result); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 5; i++ {
		add(admin, fmt.Sprintf("a-pass-%d", i), "pass")
	}
	add(admin, "a-fail", "fail")
	add(operator, "o-fail", "fail")
	add(operator, "o-err", "error")
	add(operator, "o-skip", "skipped")
	add(operator, "o-run", "")
}

type stepRow struct {
	Result   *string         `json:"result"`
	User     string          `json:"user"`
	Security json.RawMessage `json:"security"`
}

func (f *fx) steps(t *testing.T, query string) ([]stepRow, string) {
	t.Helper()
	rec := f.h.Do("GET", "/api/v1/runs/"+f.runIDs[0].String()+"/steps"+query, f.owner, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("steps%s = %d %s", query, rec.Code, rec.Body)
	}
	var out []stepRow
	f.h.JSON(rec, &out)
	return out, rec.Header().Get("X-Total-Count")
}

func TestRunSteps_AreFilteredPagedAndTotalled(t *testing.T) {
	f := setup(t, false)
	f.pagedFixture(t)

	all, total := f.steps(t, "")
	if len(all) != 10 || total != "10" {
		t.Fatalf("all = %d total %q, want 10", len(all), total)
	}
	// problems first, so a run with thousands of passes opens on what needs a look
	for i, s := range all[:3] {
		if s.Result == nil || (*s.Result != "fail" && *s.Result != "error") {
			t.Errorf("step %d of the list is %v, want failures and errors first", i, s.Result)
		}
	}

	failing, total := f.steps(t, "?result=fail,error")
	if len(failing) != 3 || total != "3" {
		t.Errorf("failures = %d total %q, want 3", len(failing), total)
	}
	operator, total := f.steps(t, "?user=operador")
	if len(operator) != 4 || total != "4" {
		t.Errorf("operador = %d total %q, want 4", len(operator), total)
	}
	for _, s := range operator {
		if s.User != "operador" {
			t.Errorf("a step of %q in the operador filter", s.User)
		}
	}
	both, total := f.steps(t, "?user=operador&result=fail")
	if len(both) != 1 || total != "1" {
		t.Errorf("operador failures = %d total %q, want 1", len(both), total)
	}

	page1, total := f.steps(t, "?limit=4")
	page2, _ := f.steps(t, "?limit=4&offset=4")
	page3, _ := f.steps(t, "?limit=4&offset=8")
	if len(page1) != 4 || len(page2) != 4 || len(page3) != 2 || total != "10" {
		t.Errorf("pages = %d/%d/%d total %q, want 4/4/2 of 10", len(page1), len(page2), len(page3), total)
	}
	// running steps (no result yet) are listed and can be asked for
	running, _ := f.steps(t, "?result=running")
	if len(running) != 1 || running[0].Result != nil {
		t.Errorf("running = %+v", running)
	}
}

func TestRunSteps_RejectsBadQueries(t *testing.T) {
	f := setup(t, false)
	for _, q := range []string{"?result=maybe", "?limit=0", "?limit=501", "?limit=abc", "?offset=-1"} {
		if c := f.h.Do("GET", "/api/v1/runs/"+f.runIDs[0].String()+"/steps"+q, f.owner, nil).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", q, c)
		}
	}
}

func TestRunNodeResults_IsTheWorstResultPerNodeWithoutTheWeightOfEveryStep(t *testing.T) {
	f := setup(t, false)
	f.pagedFixture(t)
	rec := f.h.Do("GET", "/api/v1/runs/"+f.runIDs[0].String()+"/node-results", f.owner, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("node-results = %d %s", rec.Code, rec.Body)
	}
	var rows []struct {
		NodeID string `json:"node_id"`
		Result string `json:"result"`
	}
	f.h.JSON(rec, &rows)
	// admin's node: 5 passes and a failure = fail; operador's node: fail, error, skipped, running = fail; the running step has no verdict
	if len(rows) != 2 {
		t.Fatalf("rows = %+v, want one per node", rows)
	}
	for _, r := range rows {
		if r.Result != "fail" {
			t.Errorf("%s = %q, want fail (the worst)", r.NodeID, r.Result)
		}
	}
	if c := f.h.Do("GET", "/api/v1/runs/"+uuid.NewString()+"/node-results", f.owner, nil).Code; c != http.StatusOK {
		t.Errorf("a run with nothing is an empty list, got %d", c)
	}
}

// The security checks of a run are listed on their own: they are many (one per check per screen) and are not what the
// tests of the requirements are about, so they must not crowd the list nor change a screen's verdict.
func TestRunSteps_SecurityChecksAreAskedForSeparately(t *testing.T) {
	f := setup(t, false)
	f.pagedFixture(t) // 10 functional steps
	ctx := context.Background()
	var node uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `SELECT id FROM nodes WHERE label = '/a'`).Scan(&node); err != nil {
		t.Fatal(err)
	}
	add := func(key, result string) {
		if _, err := f.h.Pool.Exec(ctx, `INSERT INTO run_steps (organization_id, run_id, client_key, node_id, executor, result, security) VALUES ($1, $2, $3, $4, 'browser', $5, '{"check":"header-csp","severity":"normal"}')`, f.h.OrgID, f.runIDs[0], key, node, result); err != nil {
			t.Fatal(err)
		}
	}
	add("sec-fail", "fail")
	add("sec-pass", "pass")

	if all, total := f.steps(t, ""); len(all) != 10 || total != "10" {
		t.Errorf("default = %d total %q, want only the 10 functional steps", len(all), total)
	}
	sec, total := f.steps(t, "?kind=security")
	if len(sec) != 2 || total != "2" {
		t.Fatalf("security = %d total %q, want 2", len(sec), total)
	}
	if sec[0].Result == nil || *sec[0].Result != "fail" {
		t.Errorf("security steps should also list the failure first: %v", sec[0].Result)
	}
	if string(sec[0].Security) == "" || !strings.Contains(string(sec[0].Security), "header-csp") {
		t.Errorf("a security step says which check it is: %q", sec[0].Security)
	}
	if every, total := f.steps(t, "?kind=all"); len(every) != 12 || total != "12" {
		t.Errorf("all = %d total %q, want 12", len(every), total)
	}
	if c := f.h.Do("GET", "/api/v1/runs/"+f.runIDs[0].String()+"/steps?kind=bogus", f.owner, nil).Code; c != http.StatusBadRequest {
		t.Errorf("bogus kind = %d, want 400", c)
	}
	// a failing security check does not turn a screen red in the flow of results: that verdict is about the requirements
	rec := f.h.Do("GET", "/api/v1/runs/"+f.runIDs[0].String()+"/node-results", f.owner, nil)
	var rows []struct {
		NodeID string `json:"node_id"`
		Result string `json:"result"`
	}
	f.h.JSON(rec, &rows)
	if len(rows) != 2 {
		t.Errorf("node results = %+v, want the same 2 nodes as before", rows)
	}
}
