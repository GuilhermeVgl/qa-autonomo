package spec_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

const oasV1 = `
openapi: 3.0.3
info: { title: Pedidos, version: "1" }
paths:
  /orders:
    get:
      responses:
        "200":
          description: ok
          content: { application/json: { schema: { type: array, items: { type: object, properties: { id: { type: integer } } } } } }
    post:
      requestBody: { required: true, content: { application/json: { schema: { type: object } } } }
      responses: { "201": { description: criado } }
  /orders/{id}:
    get:
      parameters: [ { name: id, in: path, required: true, schema: { type: integer } } ]
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: integer } } } } } }
  /health:
    get: { responses: { default: { description: x } } }
`

// v2: GET /orders changes its schema, POST /orders is gone, a new endpoint appears.
const oasV2 = `
openapi: 3.0.3
info: { title: Pedidos, version: "2" }
paths:
  /orders:
    get:
      responses:
        "200":
          description: ok
          content: { application/json: { schema: { type: array, items: { type: object, properties: { id: { type: string } } } } } }
  /orders/{id}:
    get:
      parameters: [ { name: id, in: path, required: true, schema: { type: integer } } ]
      responses:
        "200": { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: integer } } } } } }
  /customers:
    get: { responses: { "200": { description: ok } } }
`

type ingestOA struct {
	Spec struct {
		ID         string `json:"id"`
		Version    int    `json:"version"`
		SourceType string `json:"source_type"`
	} `json:"spec"`
	Requirements []struct {
		Key         string `json:"key"`
		Text        string `json:"text"`
		Criticality string `json:"criticality"`
		Status      string `json:"status"`
	} `json:"requirements"`
	Removed []struct {
		Key string `json:"key"`
	} `json:"removed"`
	Skipped []string `json:"skipped"`
}

func (f *oaFx) ingest(body string) (int, ingestOA) {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/api/v1/projects/"+f.pid+"/specs", f.owner, map[string]string{"title": "api", "source_type": "openapi", "text": body})
	var out ingestOA
	if rec.Code == http.StatusCreated {
		f.h.JSON(rec, &out)
	}
	return rec.Code, out
}

type oaFx struct {
	h     *testutil.Harness
	owner string
	pid   string
}

func oaSetup(t *testing.T, envs int) *oaFx {
	t.Helper()
	h, owner, pid := setup(t, nil) // no LLM configured: OpenAPI ingestion must not need one
	f := &oaFx{h: h, owner: owner, pid: pid}
	for i := 0; i < envs; i++ {
		if _, err := environment.New(h.Pool).CreateEnvironment(context.Background(), environment.CreateEnvironmentParams{
			OrganizationID: h.OrgID, ProjectID: uuid.MustParse(pid), Name: "env" + string(rune('a'+i)), BaseUrl: "https://api.test", AllowedHosts: []string{"api.test"}, DestructivePolicy: "block"}); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *oaFx) count(query string, args ...any) int {
	f.h.T.Helper()
	var n int
	if err := f.h.Pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		f.h.T.Fatal(err)
	}
	return n
}

func TestOpenAPI_CreatesContractRequirementsAndLinkedEndpointNodesWithoutAnLLM(t *testing.T) {
	f := oaSetup(t, 2)
	code, out := f.ingest(oasV1)
	if code != http.StatusCreated {
		t.Fatalf("ingest = %d", code)
	}
	if out.Spec.SourceType != "openapi" || out.Spec.Version != 1 {
		t.Errorf("spec = %+v", out.Spec)
	}
	keys := map[string]string{}
	for _, r := range out.Requirements {
		keys[r.Key] = r.Criticality
		if r.Status != "new" {
			t.Errorf("%s status = %s", r.Key, r.Status)
		}
	}
	if len(keys) != 3 || keys["GET /orders"] != "normal" || keys["POST /orders"] != "high" || keys["GET /orders/{id}"] == "" {
		t.Errorf("requirements = %v", keys)
	}
	if len(out.Skipped) != 1 || out.Skipped[0] != "GET /health" {
		t.Errorf("skipped = %v (an operation with no documented 2xx cannot be tested)", out.Skipped)
	}

	// every environment gets a graph (none existed) with the endpoint nodes already linked to their requirements
	if n := f.count(`SELECT count(*) FROM graphs`); n != 2 {
		t.Errorf("graphs = %d, want one per environment", n)
	}
	if n := f.count(`SELECT count(*) FROM nodes WHERE kind = 'endpoint'`); n != 6 {
		t.Errorf("endpoint nodes = %d, want 3 per environment", n)
	}
	if n := f.count(`SELECT count(*) FROM requirement_links l JOIN nodes n ON n.id = l.node_id WHERE n.kind = 'endpoint' AND l.source = 'agent' AND l.confidence = 1`); n != 6 {
		t.Errorf("deterministic links = %d, want 6", n)
	}
	var fp, meta string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT fingerprint, metadata::text FROM nodes WHERE fingerprint = 'GET /orders/{id}' LIMIT 1`).Scan(&fp, &meta); err != nil {
		t.Fatal(err)
	}
	var m struct {
		Operation struct {
			Method string `json:"method"`
			Path   string `json:"path"`
			Status int    `json:"status"`
		} `json:"operation"`
	}
	if err := json.Unmarshal([]byte(meta), &m); err != nil || m.Operation.Method != "GET" || m.Operation.Path != "/orders/{id}" || m.Operation.Status != 200 {
		t.Errorf("node metadata = %s (%v)", meta, err)
	}
}

func TestOpenAPI_NewVersionDiffsRequirementsAndRefreshesTheContract(t *testing.T) {
	f := oaSetup(t, 1)
	f.ingest(oasV1)
	code, v2 := f.ingest(oasV2)
	if code != http.StatusCreated || v2.Spec.Version != 2 {
		t.Fatalf("v2 = %d %+v", code, v2.Spec)
	}
	status := map[string]string{}
	for _, r := range v2.Requirements {
		status[r.Key] = r.Status
	}
	if status["GET /orders"] != "changed" || status["GET /orders/{id}"] != "unchanged" || status["GET /customers"] != "new" {
		t.Errorf("statuses = %v", status)
	}
	if len(v2.Removed) != 1 || v2.Removed[0].Key != "POST /orders" {
		t.Errorf("removed = %+v", v2.Removed)
	}

	// the node's contract was refreshed, the new endpoint exists, and the removed one no longer counts as covered
	var meta string
	_ = f.h.Pool.QueryRow(context.Background(), `SELECT metadata::text FROM nodes WHERE fingerprint = 'GET /orders'`).Scan(&meta)
	if !strings.Contains(meta, `"string"`) {
		t.Errorf("GET /orders contract not refreshed: %s", meta)
	}
	if n := f.count(`SELECT count(*) FROM nodes WHERE fingerprint = 'GET /customers'`); n != 1 {
		t.Error("new endpoint node missing")
	}
	if n := f.count(`SELECT count(*) FROM requirement_links l JOIN nodes n ON n.id = l.node_id WHERE n.fingerprint = 'POST /orders'`); n != 0 {
		t.Errorf("a removed operation keeps %d links, so it would still be tested", n)
	}
	// links point to the NEW version's requirements only: one per live endpoint, none duplicated
	if n := f.count(`SELECT count(*) FROM requirement_links l JOIN nodes n ON n.id = l.node_id WHERE n.kind = 'endpoint'`); n != 3 {
		t.Errorf("links = %d, want 3", n)
	}
}

func TestOpenAPI_Rejections(t *testing.T) {
	f := oaSetup(t, 1)
	for name, body := range map[string]string{
		"garbage":     "{{{",
		"swagger 2":   "swagger: '2.0'\ninfo: {title: x, version: '1'}\npaths: {}",
		"remote $ref": "openapi: 3.0.0\ninfo: {title: x, version: '1'}\npaths:\n  /a:\n    get:\n      responses:\n        '200': {description: ok, content: {application/json: {schema: {$ref: 'http://evil/x'}}}}",
	} {
		if code, _ := f.ingest(body); code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, code)
		}
	}
	if n := f.count(`SELECT count(*) FROM specs`); n != 0 {
		t.Errorf("rejected specs stored %d rows", n)
	}
	// text/document specs still need the LLM; OpenAPI does not
	rec := f.h.Do("POST", "/api/v1/projects/"+f.pid+"/specs", f.owner, map[string]string{"title": "t", "source_type": "text", "text": "x"})
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("text without LLM = %d, want 503", rec.Code)
	}
}
