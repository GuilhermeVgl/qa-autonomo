package graph_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/events"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fixture struct {
	h       *testutil.Harness
	hub     *events.Hub
	owner   string
	envID   uuid.UUID
	graphID uuid.UUID
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{}
	ctx, cancel := context.WithCancel(context.Background())
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		f.hub = events.NewHub(pool, graph.NotifyChannel)
		go func() { _ = f.hub.Run(ctx) }()
		graph.Register(mux, mw, pool, f.hub)
	})
	// registered after the pool's own cleanup, so it runs BEFORE pool.Close (LIFO); the hub holds a connection
	t.Cleanup(cancel)
	<-f.hub.Ready()
	f.owner = f.h.Login("o@x.com", "owner")

	org := f.h.OrgID
	pool := f.h.Pool
	p, err := project.New(pool).CreateProject(ctx, project.CreateProjectParams{OrganizationID: org, Name: "P"})
	if err != nil {
		t.Fatal(err)
	}
	e, err := environment.New(pool).CreateEnvironment(ctx, environment.CreateEnvironmentParams{
		OrganizationID: org, ProjectID: p.ID, Name: "hml", BaseUrl: "https://a.com", AllowedHosts: []string{"a.com"}, DestructivePolicy: "block"})
	if err != nil {
		t.Fatal(err)
	}
	f.envID = e.ID
	g, err := graph.New(pool).CreateGraph(ctx, graph.CreateGraphParams{OrganizationID: org, ProjectID: p.ID, EnvironmentID: e.ID, Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	f.graphID = g.ID
	q := graph.New(pool)
	home, _ := q.UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: org, GraphID: g.ID, Kind: "page", Fingerprint: "fp-home", Label: "/", AppRoles: []string{"admin"}, Metadata: []byte(`{}`)})
	orders, _ := q.UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: org, GraphID: g.ID, Kind: "page", Fingerprint: "fp-orders", Label: "/orders", AppRoles: []string{"admin"}, Metadata: []byte(`{}`)})
	if _, err := q.UpsertEdge(ctx, graph.UpsertEdgeParams{OrganizationID: org, GraphID: g.ID, FromNodeID: home.ID, ToNodeID: orders.ID, Key: "click a[href=/orders]", Action: []byte(`{"type":"click"}`), AppRoles: []string{"admin"}}); err != nil {
		t.Fatal(err)
	}
	return f
}

type graphView struct {
	Graph struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
	} `json:"graph"`
	Nodes []struct {
		ID          string   `json:"id"`
		Kind        string   `json:"kind"`
		Fingerprint string   `json:"fingerprint"`
		Label       string   `json:"label"`
		AppRoles    []string `json:"app_roles"`
	} `json:"nodes"`
	Edges []struct {
		From string `json:"from_node_id"`
		To   string `json:"to_node_id"`
		Key  string `json:"key"`
	} `json:"edges"`
}

func TestGraph_ReadByIDAndLatestForEnvironment(t *testing.T) {
	f := setup(t)
	for _, path := range []string{"/api/v1/graphs/" + f.graphID.String(), "/api/v1/environments/" + f.envID.String() + "/graph"} {
		rec := f.h.Do("GET", path, f.owner, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s = %d %s", path, rec.Code, rec.Body)
		}
		var v graphView
		f.h.JSON(rec, &v)
		if v.Graph.ID != f.graphID.String() || len(v.Nodes) != 2 || len(v.Edges) != 1 {
			t.Errorf("%s: %+v", path, v)
		}
		if v.Edges[0].From == v.Edges[0].To || v.Edges[0].Key == "" {
			t.Errorf("edge = %+v", v.Edges[0])
		}
	}
}

func TestGraph_NotFoundAndAuth(t *testing.T) {
	f := setup(t)
	zero := "00000000-0000-0000-0000-000000000000"
	for _, path := range []string{"/api/v1/graphs/" + zero, "/api/v1/graphs/nope", "/api/v1/environments/" + zero + "/graph"} {
		if c := f.h.Do("GET", path, f.owner, nil).Code; c != http.StatusNotFound {
			t.Errorf("%s = %d, want 404", path, c)
		}
	}
	if c := f.h.Do("GET", "/api/v1/graphs/"+f.graphID.String(), "", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("anonymous = %d, want 401", c)
	}
}

func TestGraph_StreamSendsChangeEvents(t *testing.T) {
	f := setup(t)
	srv := httptest.NewServer(f.h.Mux)
	defer srv.Close()

	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/graphs/"+f.graphID.String()+"/stream", nil)
	req.Header.Set("Authorization", "Bearer "+f.owner)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status=%d type=%q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}

	lines := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	waitFor := func(want string) {
		t.Helper()
		for {
			select {
			case l, ok := <-lines:
				if !ok {
					t.Fatalf("stream closed before %q", want)
				}
				if strings.Contains(l, want) {
					return
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("timeout waiting for %q", want)
			}
		}
	}
	waitFor("event: ready") // stream is subscribed from here on
	if err := events.Notify(ctx, f.h.Pool, graph.NotifyChannel, f.graphID.String()); err != nil {
		t.Fatal(err)
	}
	waitFor("event: graph_changed")
}

type nodeStatusRow struct {
	NodeID  string `json:"node_id"`
	Status  string `json:"status"`
	RunID   string `json:"run_id"`
	Passed  int    `json:"passed"`
	Failed  int    `json:"failed"`
	Errored int    `json:"errored"`
	Skipped int    `json:"skipped"`
}

// addRun inserts a finished run of the environment and returns its id.
func (f *fixture) addRun(t *testing.T, graphID uuid.UUID, typ string) uuid.UUID {
	t.Helper()
	var projectID uuid.UUID
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT project_id FROM environments WHERE id = $1`, f.envID).Scan(&projectID); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	if err := f.h.Pool.QueryRow(context.Background(), `INSERT INTO runs (organization_id, project_id, environment_id, graph_id, type, trigger, status)
		VALUES ($1, $2, $3, $4, $5, 'manual', 'succeeded') RETURNING id`, f.h.OrgID, projectID, f.envID, graphID, typ).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f *fixture) addStep(t *testing.T, runID uuid.UUID, nodeID uuid.UUID, key, result string) {
	t.Helper()
	if _, err := f.h.Pool.Exec(context.Background(), `INSERT INTO run_steps (organization_id, run_id, client_key, node_id, executor, result)
		VALUES ($1, $2, $3, $4, 'browser', $5)`, f.h.OrgID, runID, key, nodeID, result); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) nodeStatus(t *testing.T) map[string]nodeStatusRow {
	t.Helper()
	rec := f.h.Do("GET", "/api/v1/environments/"+f.envID.String()+"/node-status", f.owner, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("node-status = %d %s", rec.Code, rec.Body)
	}
	var rows []nodeStatusRow
	f.h.JSON(rec, &rows)
	out := map[string]nodeStatusRow{}
	for _, r := range rows {
		out[r.NodeID] = r
	}
	return out
}

func TestNodeStatus_WorstResultOfTheLatestRunThatTestedEachNode(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	q := graph.New(f.h.Pool)
	nodes, _ := q.ListNodes(ctx, graph.ListNodesParams{OrganizationID: f.h.OrgID, GraphID: f.graphID})
	id := map[string]uuid.UUID{}
	for _, n := range nodes {
		id[n.Label] = n.ID
	}

	if got := f.nodeStatus(t); len(got) != 0 {
		t.Fatalf("nothing tested yet, got %+v", got)
	}

	old := f.addRun(t, f.graphID, "regression")
	f.addStep(t, old, id["/orders"], "o1", "fail")
	f.addStep(t, old, id["/"], "h1", "pass")

	latest := f.addRun(t, f.graphID, "regression")
	f.addStep(t, latest, id["/orders"], "o1", "pass")      // the page passed in the newest run...
	f.addStep(t, latest, id["/orders"], "o2#FORM", "fail") // ...but one of its forms failed: the node is failing
	f.addStep(t, latest, id["/orders"], "o3#FORM", "skipped")

	got := f.nodeStatus(t)
	o := got[id["/orders"].String()]
	if o.Status != "fail" || o.Passed != 1 || o.Failed != 1 || o.Skipped != 1 || o.RunID != latest.String() {
		t.Errorf("/orders = %+v, want fail from the latest run with 1 pass, 1 fail, 1 skipped", o)
	}
	// the home page was only tested by the older run: that is still its last word
	if h := got[id["/"].String()]; h.Status != "pass" || h.RunID != old.String() {
		t.Errorf("/ = %+v, want pass from the older run", h)
	}
}

func TestNodeStatus_FollowsTheScreenIntoANewerVersionOfTheGraph(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	q := graph.New(f.h.Pool)
	nodes, _ := q.ListNodes(ctx, graph.ListNodesParams{OrganizationID: f.h.OrgID, GraphID: f.graphID})
	var oldOrders uuid.UUID
	for _, n := range nodes {
		if n.Label == "/orders" {
			oldOrders = n.ID
		}
	}
	run := f.addRun(t, f.graphID, "regression")
	f.addStep(t, run, oldOrders, "o1", "fail")

	// a new exploration creates a new version with new node ids for the same screens (same fingerprints)
	var projectID uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `SELECT project_id FROM environments WHERE id = $1`, f.envID).Scan(&projectID)
	g2, err := q.CreateGraph(ctx, graph.CreateGraphParams{OrganizationID: f.h.OrgID, ProjectID: projectID, EnvironmentID: f.envID, Version: 2})
	if err != nil {
		t.Fatal(err)
	}
	newOrders, _ := q.UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: f.h.OrgID, GraphID: g2.ID, Kind: "page", Fingerprint: "fp-orders", Label: "/orders", AppRoles: []string{"admin"}, Metadata: []byte(`{}`)})
	other, _ := q.UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: f.h.OrgID, GraphID: g2.ID, Kind: "page", Fingerprint: "fp-other", Label: "/other", AppRoles: []string{"admin"}, Metadata: []byte(`{}`)})

	got := f.nodeStatus(t) // the latest graph is version 2
	if s := got[newOrders.ID.String()]; s.Status != "fail" {
		t.Errorf("the same screen in the new graph = %+v, want the previous verdict (fail)", s)
	}
	if _, tested := got[other.ID.String()]; tested {
		t.Errorf("a screen never tested has no status, got %+v", got[other.ID.String()])
	}
}

func TestNodeStatus_UnknownEnvironmentIs404(t *testing.T) {
	f := setup(t)
	if c := f.h.Do("GET", "/api/v1/environments/"+uuid.NewString()+"/node-status", f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("unknown environment = %d, want 404", c)
	}
}

func TestGraph_NodesSayHowManyRequirementsCoverThem(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	q := graph.New(f.h.Pool)
	nodes, _ := q.ListNodes(ctx, graph.ListNodesParams{OrganizationID: f.h.OrgID, GraphID: f.graphID})
	var orders uuid.UUID
	for _, n := range nodes {
		if n.Label == "/orders" {
			orders = n.ID
		}
	}
	var projectID, specID uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `SELECT project_id FROM environments WHERE id = $1`, f.envID).Scan(&projectID)
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO specs (organization_id, project_id, version, source_type, title, extracted_text) VALUES ($1, $2, 1, 'auto', 't', '') RETURNING id`, f.h.OrgID, projectID).Scan(&specID); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"PAGE /orders", "FORM POST /orders"} {
		var rid uuid.UUID
		if err := f.h.Pool.QueryRow(ctx, `INSERT INTO requirements (organization_id, spec_id, key, text, criticality, status) VALUES ($1, $2, $3, 'x', 'normal', 'new') RETURNING id`, f.h.OrgID, specID, key).Scan(&rid); err != nil {
			t.Fatal(err)
		}
		if _, err := f.h.Pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 1, 'agent')`, f.h.OrgID, rid, orders); err != nil {
			t.Fatal(err)
		}
	}
	var out struct {
		Nodes []struct {
			ID    string   `json:"id"`
			Label string   `json:"label"`
			Count int      `json:"requirement_count"`
			Keys  []string `json:"requirement_keys"`
		} `json:"nodes"`
	}
	f.h.JSON(f.h.Do("GET", "/api/v1/graphs/"+f.graphID.String(), f.owner, nil), &out)
	got := map[string]int{}
	keys := map[string][]string{}
	for _, n := range out.Nodes {
		got[n.Label] = n.Count
		keys[n.Label] = n.Keys
	}
	if len(keys["/orders"]) != 2 || keys["/orders"][0] != "FORM POST /orders" || keys["/orders"][1] != "PAGE /orders" || keys["/"] == nil || len(keys["/"]) != 0 {
		t.Errorf("requirement_keys = %v, want /orders covered by FORM POST /orders and PAGE /orders, and / by none (an empty list, never null)", keys)
	}
	if got["/orders"] != 2 || got["/"] != 0 {
		t.Errorf("requirement_count = %+v, want /orders 2 and / 0 (any spec counts, including the generated one)", got)
	}
}
