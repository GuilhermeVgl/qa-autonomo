package runnerapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/runnerapi"
	"github.com/kpmg/agent-qa/control-plane/internal/secret"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

const bootstrap = "bootstrap-secret"

type fx struct {
	h       *testutil.Harness
	owner   string
	envID   string
	runner  string // runner token
	runner2 string
}

func setup(t *testing.T) *fx { return setupWith(t, nil) }

// memStore is an in-memory object store; objects "uploaded by the runner" are put straight into it.
type memStore struct {
	objects map[string][]byte
	deleted []string
}

func newMemStore() *memStore { return &memStore{objects: map[string][]byte{}} }

func (m *memStore) Size(_ context.Context, k string) (int64, error) {
	b, ok := m.objects[k]
	if !ok {
		return 0, errors.New("not found")
	}
	return int64(len(b)), nil
}
func (m *memStore) Delete(_ context.Context, k string) error {
	delete(m.objects, k)
	m.deleted = append(m.deleted, k)
	return nil
}
func (m *memStore) PresignPut(_ context.Context, k string, _ time.Duration) (string, error) {
	return "http://store.test/put/" + k + "?sig=1", nil
}

// setupWith lets a test attach an LLM gateway built on the harness pool (nil = no LLM configured).
func setupWith(t *testing.T, mkLLM func(*pgxpool.Pool) runnerapi.Completer) *fx {
	return setupFull(t, mkLLM, nil)
}

func setupFull(t *testing.T, mkLLM func(*pgxpool.Pool) runnerapi.Completer, store runnerapi.Storage) *fx {
	t.Helper()
	box, err := secret.New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	f := &fx{}
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		project.Register(mux, mw, pool)
		environment.Register(mux, mw, pool, box)
		run.Register(mux, mw, pool)
		graph.Register(mux, mw, pool, nil)
	})
	// runnerapi needs the org id, known only after the harness exists
	var completer runnerapi.Completer
	if mkLLM != nil {
		completer = mkLLM(f.h.Pool)
	}
	runnerapi.Register(f.h.Mux, f.h.Pool, runnerapi.Deps{Box: box, BootstrapToken: bootstrap, OrganizationID: f.h.OrgID, LLM: completer, Storage: store})
	f.owner = f.h.Login("o@x.com", "owner")

	var p struct{ ID string }
	f.h.JSON(f.h.Do("POST", "/api/v1/projects", f.owner, map[string]string{"name": "P"}), &p)
	var e struct{ ID string }
	f.h.JSON(f.h.Do("POST", "/api/v1/projects/"+p.ID+"/environments", f.owner,
		map[string]any{"name": "hml", "base_url": "https://a.com"}), &e)
	f.envID = e.ID
	f.h.Do("PUT", "/api/v1/environments/"+e.ID+"/credentials", f.owner,
		map[string]any{"app_role": "admin", "kind": "login", "payload": map[string]string{"username": "adm", "password": "pw"}})

	f.runner = f.register("r1")
	f.runner2 = f.register("r2")
	return f
}

func (f *fx) register(name string) string {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/runner/v1/register", "", map[string]any{"bootstrap_token": bootstrap, "name": name, "labels": []string{"browser"}, "version": "0.0.1"})
	if rec.Code != http.StatusOK {
		f.h.T.Fatalf("register = %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Token string `json:"token"`
	}
	f.h.JSON(rec, &out)
	return out.Token
}

func (f *fx) newRun() string {
	f.h.T.Helper()
	var r struct{ ID string }
	f.h.JSON(f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "exploration"}), &r)
	return r.ID
}

type job struct {
	RunID       string `json:"run_id"`
	Attempt     int    `json:"attempt"`
	GraphID     string `json:"graph_id"`
	Type        string `json:"type"`
	Environment struct {
		Device            string   `json:"device"`
		BaseURL           string   `json:"base_url"`
		AllowedHosts      []string `json:"allowed_hosts"`
		DestructivePolicy string   `json:"destructive_policy"`
	} `json:"environment"`
	Credentials []struct {
		AppRole string            `json:"app_role"`
		Kind    string            `json:"kind"`
		Payload map[string]string `json:"payload"`
	} `json:"credentials"`
	Budget map[string]int `json:"budget"`
}

func (f *fx) lease(token string) (job, int) {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", token, nil)
	var j job
	if rec.Code == http.StatusOK {
		f.h.JSON(rec, &j)
	}
	return j, rec.Code
}

func ev(seq int, typ string, payload map[string]any) map[string]any {
	return map[string]any{"seq": seq, "type": typ, "payload": payload}
}

func (f *fx) events(token, runID string, evs ...map[string]any) int {
	f.h.T.Helper()
	return f.h.Do("POST", "/runner/v1/jobs/"+runID+"/events", token, map[string]any{"events": evs}).Code
}

func (f *fx) graphOf(j job) (nodes, edges []map[string]any) {
	f.h.T.Helper()
	var v struct {
		Nodes []map[string]any `json:"nodes"`
		Edges []map[string]any `json:"edges"`
	}
	f.h.JSON(f.h.Do("GET", "/api/v1/graphs/"+j.GraphID, f.owner, nil), &v)
	return v.Nodes, v.Edges
}

func TestRegister(t *testing.T) {
	f := setup(t)
	for name, body := range map[string]map[string]any{
		"wrong token": {"bootstrap_token": "nope", "name": "x"},
		"empty token": {"bootstrap_token": "", "name": "x"},
	} {
		if c := f.h.Do("POST", "/runner/v1/register", "", body).Code; c != http.StatusUnauthorized {
			t.Errorf("%s = %d, want 401", name, c)
		}
	}
	if c := f.h.Do("POST", "/runner/v1/register", "", map[string]any{"bootstrap_token": bootstrap, "name": ""}).Code; c != http.StatusBadRequest {
		t.Errorf("empty name = %d, want 400", c)
	}
	if c := f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", "", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("lease without token = %d, want 401", c)
	}
	if c := f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", "bogus", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("lease with bad token = %d, want 401", c)
	}
	// a user token is not a runner token
	if c := f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", f.owner, nil).Code; c != http.StatusUnauthorized {
		t.Errorf("lease with user token = %d, want 401", c)
	}
}

func TestLease_ReturnsJobWithDecryptedCredentialsAndEnforcesEnvLock(t *testing.T) {
	f := setup(t)
	if _, c := f.lease(f.runner); c != http.StatusNoContent {
		t.Fatalf("empty queue = %d, want 204", c)
	}
	first, second := f.newRun(), f.newRun()
	j, c := f.lease(f.runner)
	if c != http.StatusOK || j.RunID != first || j.Attempt != 1 || j.Type != "exploration" {
		t.Fatalf("lease = %d %+v", c, j)
	}
	if j.Environment.BaseURL != "https://a.com" || len(j.Environment.AllowedHosts) != 1 || j.Environment.DestructivePolicy != "block" {
		t.Errorf("environment = %+v", j.Environment)
	}
	if len(j.Credentials) != 1 || j.Credentials[0].Payload["password"] != "pw" || j.Credentials[0].AppRole != "admin" {
		t.Errorf("credentials = %+v", j.Credentials)
	}
	if j.Budget["max_pages"] == 0 || j.GraphID == "" {
		t.Errorf("job = %+v", j)
	}
	// same environment already has a running run: the second stays queued, for any runner
	if _, c := f.lease(f.runner2); c != http.StatusNoContent {
		t.Errorf("env lock: lease = %d, want 204", c)
	}
	// finishing the first frees the environment
	if c := f.h.Do("POST", "/runner/v1/jobs/"+first+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}}).Code; c != http.StatusOK {
		t.Fatalf("complete = %d", c)
	}
	j2, c := f.lease(f.runner2)
	if c != http.StatusOK || j2.RunID != second {
		t.Errorf("after complete: %d %+v", c, j2)
	}
}

func TestEvents_AppliedIdempotentlyAndMerged(t *testing.T) {
	f := setup(t)
	f.newRun()
	j, _ := f.lease(f.runner)

	home := ev(1, "node_discovered", map[string]any{"fingerprint": "fp-home", "kind": "page", "label": "/", "app_role": "admin", "metadata": map[string]any{"title": "Home"}})
	orders := ev(2, "node_discovered", map[string]any{"fingerprint": "fp-orders", "kind": "page", "label": "/orders", "app_role": "admin"})
	edge := ev(3, "edge_discovered", map[string]any{"key": "click a[href=/orders]", "from_fingerprint": "fp-home", "to_fingerprint": "fp-orders", "action": map[string]any{"type": "click", "selector": "a[href=/orders]"}, "app_role": "admin"})
	if c := f.events(f.runner, j.RunID, home, orders, edge); c != http.StatusOK {
		t.Fatalf("events = %d", c)
	}
	// resend the whole batch (network retry): nothing duplicates
	if c := f.events(f.runner, j.RunID, home, orders, edge); c != http.StatusOK {
		t.Fatalf("resend = %d", c)
	}
	nodes, edges := f.graphOf(j)
	if len(nodes) != 2 || len(edges) != 1 {
		t.Fatalf("nodes=%d edges=%d, want 2/1", len(nodes), len(edges))
	}

	// the same state seen by another role merges roles instead of duplicating the node
	other := ev(4, "node_discovered", map[string]any{"fingerprint": "fp-home", "kind": "page", "label": "/", "app_role": "operator"})
	if c := f.events(f.runner, j.RunID, other); c != http.StatusOK {
		t.Fatal(c)
	}
	nodes, _ = f.graphOf(j)
	if len(nodes) != 2 {
		t.Fatalf("nodes = %d, want 2", len(nodes))
	}
	for _, n := range nodes {
		if n["fingerprint"] == "fp-home" {
			roles, _ := n["app_roles"].([]any)
			if len(roles) != 2 {
				t.Errorf("roles = %v, want admin+operator", roles)
			}
		}
	}
}

func TestEvents_Validation(t *testing.T) {
	f := setup(t)
	f.newRun()
	j, _ := f.lease(f.runner)
	cases := map[string]map[string]any{
		"unknown type":         ev(1, "teleport", map[string]any{}),
		"node w/o fingerprint": ev(1, "node_discovered", map[string]any{"kind": "page", "label": "/"}),
		"node bad kind":        ev(1, "node_discovered", map[string]any{"fingerprint": "x", "kind": "galaxy", "label": "/"}),
		"edge unknown node":    ev(1, "edge_discovered", map[string]any{"key": "k", "from_fingerprint": "nope", "to_fingerprint": "nope2", "action": map[string]any{}}),
		"zero seq":             ev(0, "node_discovered", map[string]any{"fingerprint": "x", "kind": "page", "label": "/"}),
	}
	for name, e := range cases {
		if c := f.events(f.runner, j.RunID, e); c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	// a rejected batch applies nothing
	good := ev(1, "node_discovered", map[string]any{"fingerprint": "ok", "kind": "page", "label": "/"})
	bad := ev(2, "teleport", map[string]any{})
	if c := f.events(f.runner, j.RunID, good, bad); c != http.StatusBadRequest {
		t.Fatalf("mixed batch = %d, want 400", c)
	}
	if nodes, _ := f.graphOf(j); len(nodes) != 0 {
		t.Errorf("rejected batch leaked %d nodes", len(nodes))
	}
}

func TestJobOwnership(t *testing.T) {
	f := setup(t)
	runID := f.newRun()
	j, _ := f.lease(f.runner)
	e := ev(1, "node_discovered", map[string]any{"fingerprint": "x", "kind": "page", "label": "/"})
	if c := f.events(f.runner2, j.RunID, e); c != http.StatusNotFound {
		t.Errorf("other runner events = %d, want 404", c)
	}
	if c := f.h.Do("POST", "/runner/v1/jobs/"+runID+"/heartbeat", f.runner2, nil).Code; c != http.StatusNotFound {
		t.Errorf("other runner heartbeat = %d, want 404", c)
	}
	if c := f.h.Do("POST", "/runner/v1/jobs/"+runID+"/complete", f.runner2, map[string]any{"status": "failed", "summary": map[string]any{}}).Code; c != http.StatusNotFound {
		t.Errorf("other runner complete = %d, want 404", c)
	}
}

func TestHeartbeatAndCancel(t *testing.T) {
	f := setup(t)
	runID := f.newRun()
	j, _ := f.lease(f.runner)
	rec := f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/heartbeat", f.runner, nil)
	var hb struct {
		Cancel bool `json:"cancel"`
	}
	f.h.JSON(rec, &hb)
	if rec.Code != http.StatusOK || hb.Cancel {
		t.Fatalf("heartbeat = %d cancel=%v", rec.Code, hb.Cancel)
	}
	if c := f.h.Do("POST", "/api/v1/runs/"+runID+"/cancel", f.owner, nil).Code; c != http.StatusOK {
		t.Fatalf("cancel = %d", c)
	}
	rec = f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/heartbeat", f.runner, nil)
	f.h.JSON(rec, &hb)
	if rec.Code != http.StatusOK || !hb.Cancel {
		t.Errorf("heartbeat after cancel = %d cancel=%v, want cancel=true", rec.Code, hb.Cancel)
	}
	e := ev(1, "node_discovered", map[string]any{"fingerprint": "x", "kind": "page", "label": "/"})
	if c := f.events(f.runner, j.RunID, e); c != http.StatusConflict {
		t.Errorf("events after cancel = %d, want 409", c)
	}
}

func TestComplete(t *testing.T) {
	f := setup(t)
	runID := f.newRun()
	j, _ := f.lease(f.runner)
	if c := f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "bogus", "summary": map[string]any{}}).Code; c != http.StatusBadRequest {
		t.Errorf("bad status = %d, want 400", c)
	}
	rec := f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{"pages": 3}})
	if rec.Code != http.StatusOK {
		t.Fatalf("complete = %d %s", rec.Code, rec.Body)
	}
	var got struct {
		Status  string         `json:"status"`
		Summary map[string]int `json:"summary"`
	}
	f.h.JSON(f.h.Do("GET", "/api/v1/runs/"+runID, f.owner, nil), &got)
	if got.Status != "succeeded" || got.Summary["pages"] != 3 {
		t.Errorf("run = %+v", got)
	}
	if c := f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}}).Code; c != http.StatusConflict {
		t.Errorf("complete twice = %d, want 409", c)
	}
}

func TestExpiredLeaseRequeuesThenFailsAfterThreeAttempts(t *testing.T) {
	f := setup(t)
	runID := f.newRun()
	expire := func() {
		if _, err := f.h.Pool.Exec(context.Background(), `UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, runID); err != nil {
			t.Fatal(err)
		}
	}
	for attempt := 1; attempt <= 3; attempt++ {
		j, c := f.lease(f.runner2)
		if c != http.StatusOK || j.Attempt != attempt {
			t.Fatalf("attempt %d: lease = %d %+v", attempt, c, j)
		}
		// events restart at seq 1 on every attempt and must still be accepted
		e := ev(1, "node_discovered", map[string]any{"fingerprint": "fp", "kind": "page", "label": "/"})
		if c := f.events(f.runner2, j.RunID, e); c != http.StatusOK {
			t.Fatalf("attempt %d events = %d", attempt, c)
		}
		expire()
	}
	if _, c := f.lease(f.runner); c != http.StatusNoContent {
		t.Errorf("after 3 attempts lease = %d, want 204", c)
	}
	var got struct{ Status string }
	f.h.JSON(f.h.Do("GET", "/api/v1/runs/"+runID, f.owner, nil), &got)
	if got.Status != "failed" {
		t.Errorf("status = %q, want failed", got.Status)
	}
}

// ---- LLM proxy ----

type fakeProvider struct {
	err   error
	model string
	msgs  []llm.Message
}

func (p *fakeProvider) Chat(_ context.Context, model string, msgs []llm.Message, _ bool) (llm.Result, error) {
	p.model, p.msgs = model, msgs
	return llm.Result{Content: `{"order":[0]}`, TokensIn: 4, TokensOut: 2}, p.err
}

func withGateway(p llm.Provider) func(*pgxpool.Pool) runnerapi.Completer {
	return func(pool *pgxpool.Pool) runnerapi.Completer {
		return llm.NewGateway(p, "fake", map[string]string{"explore": "strong", "plan": "strong"}, "", llm.NewRecorder(pool))
	}
}

var chatBody = map[string]any{
	"model":    "ignored-by-gateway",
	"messages": []map[string]string{{"role": "system", "content": "s"}, {"role": "user", "content": "u"}},
}

func (f *fx) chat(token, runID, task string, body map[string]any) *httptest.ResponseRecorder {
	f.h.T.Helper()
	headers := map[string]string{}
	if runID != "" {
		headers["X-QA-Run-Id"] = runID
	}
	if task != "" {
		headers["X-QA-Task"] = task
	}
	return f.h.DoWith("POST", "/runner/v1/llm/chat/completions", token, body, headers)
}

func TestLLMProxy_RoutesByTaskReturnsOpenAIShapeAndRecordsUsagePerRun(t *testing.T) {
	p := &fakeProvider{}
	f := setupWith(t, withGateway(p))
	f.newRun()
	j, _ := f.lease(f.runner)

	rec := f.chat(f.runner, j.RunID, "", chatBody) // default task = explore
	if rec.Code != http.StatusOK {
		t.Fatalf("chat = %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Choices []struct {
			Message struct{ Role, Content string }
		}
	}
	f.h.JSON(rec, &out)
	if len(out.Choices) != 1 || out.Choices[0].Message.Content != `{"order":[0]}` || out.Choices[0].Message.Role != "assistant" {
		t.Errorf("response = %s", rec.Body)
	}
	if p.model != "strong" || len(p.msgs) != 2 {
		t.Errorf("provider saw model=%q msgs=%v; the model comes from task routing, not from the runner", p.model, p.msgs)
	}

	var task string
	var runID *string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT task, run_id::text FROM llm_usage`).Scan(&task, &runID); err != nil {
		t.Fatal(err)
	}
	if task != "explore" || runID == nil || *runID != j.RunID {
		t.Errorf("usage task=%q run=%v, want explore/%s", task, runID, j.RunID)
	}
}

func TestLLMProxy_Guardrails(t *testing.T) {
	p := &fakeProvider{}
	f := setupWith(t, withGateway(p))
	runID := f.newRun()
	j, _ := f.lease(f.runner)

	if c := f.chat("", j.RunID, "", chatBody).Code; c != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", c)
	}
	if c := f.chat(f.runner, "", "", chatBody).Code; c != http.StatusBadRequest {
		t.Errorf("missing run header = %d, want 400", c)
	}
	if c := f.chat(f.runner, "not-a-uuid", "", chatBody).Code; c != http.StatusBadRequest {
		t.Errorf("bad run header = %d, want 400", c)
	}
	if c := f.chat(f.runner2, j.RunID, "", chatBody).Code; c != http.StatusNotFound {
		t.Errorf("run of another runner = %d, want 404", c)
	}
	for _, task := range []string{"extract_requirements", "summarize", "nope"} {
		if c := f.chat(f.runner, j.RunID, task, chatBody).Code; c != http.StatusBadRequest {
			t.Errorf("task %q = %d, want 400 (runners may only use explore/plan/judge_result)", task, c)
		}
	}
	for name, body := range map[string]map[string]any{
		"no messages":  {"messages": []map[string]string{}},
		"bad role":     {"messages": []map[string]string{{"role": "tool", "content": "x"}}},
		"empty body":   {},
		"too many":     {"messages": manyMessages(25)},
		"huge message": {"messages": []map[string]string{{"role": "user", "content": string(make([]byte, 200_000))}}},
	} {
		if c := f.chat(f.runner, j.RunID, "", body).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
	// no provider call happened for any rejected request
	if p.msgs != nil {
		t.Error("rejected requests must not reach the provider")
	}

	// a finished run cannot keep spending
	f.h.Do("POST", "/runner/v1/jobs/"+j.RunID+"/complete", f.runner, map[string]any{"status": "succeeded", "summary": map[string]any{}})
	if c := f.chat(f.runner, runID, "", chatBody).Code; c != http.StatusConflict {
		t.Errorf("finished run = %d, want 409", c)
	}
}

func manyMessages(n int) []map[string]string {
	out := make([]map[string]string, n)
	for i := range out {
		out[i] = map[string]string{"role": "user", "content": "x"}
	}
	return out
}

func TestLLMProxy_ProviderFailureAndNoLLM(t *testing.T) {
	f := setupWith(t, withGateway(&fakeProvider{err: errors.New("boom")}))
	f.newRun()
	j, _ := f.lease(f.runner)
	if c := f.chat(f.runner, j.RunID, "", chatBody).Code; c != http.StatusBadGateway {
		t.Errorf("provider error = %d, want 502", c)
	}

	none := setup(t)
	none.newRun()
	j2, _ := none.lease(none.runner)
	if c := none.chat(none.runner, j2.RunID, "", chatBody).Code; c != http.StatusServiceUnavailable {
		t.Errorf("no LLM = %d, want 503", c)
	}
}
