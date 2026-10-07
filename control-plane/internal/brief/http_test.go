package brief_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/brief"
	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fakeAI struct {
	reply string
	calls int
}

func (f *fakeAI) Complete(_ context.Context, _ uuid.UUID, _ string, _ []llm.Message, _ bool) (string, error) {
	f.calls++
	return f.reply, nil
}

const aiReply = `{"executive_summary":"Resumo do ambiente.","sections":[
{"id":"scope","body":"Escopo."},{"id":"coverage","body":"Cobertura."},{"id":"flows","body":"Fluxos."},{"id":"users","body":"Usuários."},
{"id":"results","body":"Resultados."},{"id":"risks","body":"Riscos."},{"id":"security","body":"Segurança."},{"id":"next","body":"Próximos passos."}],"recommendations":["Explorar."]}`

type fx struct {
	h     *testutil.Harness
	w     *testutil.World
	owner string
	ai    *fakeAI
}

func setup(t *testing.T, withAI bool) *fx {
	t.Helper()
	f := &fx{ai: &fakeAI{reply: aiReply}}
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		var c brief.Completer
		if withAI {
			c = f.ai
		}
		brief.Register(mux, mw, pool, c, brief.Capabilities{LLM: withAI, Storage: true})
	})
	f.owner = f.h.Login("o@x.com", "owner")
	f.w = f.h.SeedWorld() // /orders (REQ-001 critical) and /customers (REQ-002 high) are covered; /reports is not
	return f
}

type briefOut struct {
	Facts struct {
		Project     string `json:"project"`
		Environment struct {
			Name string `json:"name"`
		} `json:"environment"`
		Users []string `json:"users"`
		Map   struct {
			Screens  int  `json:"screens"`
			Explored bool `json:"explored"`
		} `json:"map"`
		Coverage struct {
			Requirements              int      `json:"requirements"`
			Linked                    int      `json:"linked"`
			Screens                   int      `json:"screens"`
			ScreensWithoutRequirement []string `json:"screens_without_requirement"`
		} `json:"coverage"`
		Regression *struct {
			Failed int `json:"failed"`
			Passed int `json:"passed"`
		} `json:"regression"`
		Bugs struct {
			Open int `json:"open"`
		} `json:"bugs"`
		Issues []struct {
			Code string `json:"code"`
		} `json:"issues"`
		Readiness []struct {
			ID string `json:"id"`
			OK bool   `json:"ok"`
		} `json:"readiness"`
	} `json:"facts"`
	Narrative struct {
		Source           string `json:"source"`
		ExecutiveSummary string `json:"executive_summary"`
		Sections         []struct {
			ID string `json:"id"`
		} `json:"sections"`
	} `json:"narrative"`
}

func (f *fx) get(t *testing.T, path string) (int, briefOut) {
	t.Helper()
	rec := f.h.Do("GET", "/api/v1/environments/"+f.w.EnvID.String()+path, f.owner, nil)
	var out briefOut
	if rec.Code == http.StatusOK {
		f.h.JSON(rec, &out)
	}
	return rec.Code, out
}

func TestBrief_BuildsTheFactsOfAnEnvironmentFromWhatThePlatformKnows(t *testing.T) {
	f := setup(t, false)
	run := f.w.NewRun("regression", time.Now().Add(-time.Hour), time.Minute)
	f.w.Step(run, "/orders", "fail", "HTTP 500")
	f.w.Step(run, "/customers", "pass", "ok")

	code, out := f.get(t, "/brief")
	if code != http.StatusOK {
		t.Fatalf("brief = %d", code)
	}
	if out.Facts.Project != "P" || out.Facts.Environment.Name != "hml" || !out.Facts.Map.Explored || out.Facts.Map.Screens != 3 {
		t.Errorf("facts = %+v", out.Facts)
	}
	c := out.Facts.Coverage
	if c.Requirements != 2 || c.Linked != 2 || c.Screens != 3 || len(c.ScreensWithoutRequirement) != 1 || c.ScreensWithoutRequirement[0] != "/reports" {
		t.Errorf("coverage = %+v, want /reports as the only screen no requirement talks about", c)
	}
	if r := out.Facts.Regression; r == nil || r.Failed != 1 || r.Passed != 1 {
		t.Errorf("regression = %+v", out.Facts.Regression)
	}
	if out.Facts.Bugs.Open != 1 {
		t.Errorf("open bugs = %d, want the 500 of /orders", out.Facts.Bugs.Open)
	}
	codes := map[string]bool{}
	for _, i := range out.Facts.Issues {
		codes[i.Code] = true
	}
	if !codes["screens_without_requirement"] || !codes["open_critical_bugs"] || !codes["failing_critical"] {
		t.Errorf("issues = %v", codes)
	}
	// a template narrative comes with it, instantly and without a model
	if out.Narrative.Source != "template" || len(out.Narrative.Sections) != 8 || out.Narrative.ExecutiveSummary == "" {
		t.Errorf("narrative = %+v", out.Narrative)
	}
	ready := map[string]bool{}
	for _, c := range out.Facts.Readiness {
		ready[c.ID] = c.OK
	}
	if ready["llm"] || !ready["storage"] || !ready["map"] || !ready["regression"] {
		t.Errorf("readiness = %v (no LLM was configured here, storage was)", ready)
	}
}

func TestBrief_TheSpecOfAnotherEnvironmentsMapDoesNotCount(t *testing.T) {
	f := setup(t, false)
	ctx := context.Background()
	// the automatic spec of ANOTHER environment of the project: its requirement must not appear in this environment's report
	var env2, spec2 uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO environments (organization_id, project_id, name, base_url, allowed_hosts, destructive_policy) VALUES ($1, $2, 'lab', 'https://lab.a.com', '{lab.a.com}', 'block') RETURNING id`, f.h.OrgID, f.w.ProjectID).Scan(&env2); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO specs (organization_id, project_id, version, source_type, title, extracted_text, environment_id) VALUES ($1, $2, 9, 'auto', 'Varredura automática · lab', '', $3) RETURNING id`, f.h.OrgID, f.w.ProjectID, env2).Scan(&spec2); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Pool.Exec(ctx, `INSERT INTO requirements (organization_id, spec_id, key, text, criticality, status) VALUES ($1, $2, 'PAGE /lab', 'x', 'normal', 'new')`, f.h.OrgID, spec2); err != nil {
		t.Fatal(err)
	}
	if _, out := f.get(t, "/brief"); out.Facts.Coverage.Requirements != 2 {
		t.Errorf("requirements = %d, want only the 2 of this environment's own specs", out.Facts.Coverage.Requirements)
	}
}

func TestBrief_AnEnvironmentWithoutMapSaysSoInsteadOfFailing(t *testing.T) {
	f := setup(t, false)
	if _, err := f.h.Pool.Exec(context.Background(), `DELETE FROM requirement_links WHERE organization_id = $1`, f.h.OrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Pool.Exec(context.Background(), `DELETE FROM nodes WHERE graph_id = $1`, f.w.GraphID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Pool.Exec(context.Background(), `DELETE FROM graphs WHERE id = $1`, f.w.GraphID); err != nil {
		t.Fatal(err)
	}
	code, out := f.get(t, "/brief")
	if code != http.StatusOK || out.Facts.Map.Explored {
		t.Fatalf("brief = %d explored=%v", code, out.Facts.Map.Explored)
	}
	if len(out.Facts.Issues) == 0 || out.Facts.Issues[0].Code != "no_map" || !strings.Contains(strings.ToLower(out.Narrative.ExecutiveSummary), "explor") {
		t.Errorf("an environment with no map must say to explore first: %+v", out)
	}
}

func TestBrief_TheNarrativeByAIKeepsTheFacts(t *testing.T) {
	f := setup(t, true)
	rec := f.h.Do("POST", "/api/v1/environments/"+f.w.EnvID.String()+"/brief/narrative", f.owner, map[string]any{})
	if rec.Code != http.StatusOK {
		t.Fatalf("narrative = %d %s", rec.Code, rec.Body)
	}
	var out briefOut
	f.h.JSON(rec, &out)
	if out.Narrative.Source != "ai" || len(out.Narrative.Sections) != 8 || out.Facts.Coverage.Requirements != 2 {
		t.Errorf("out = %+v: the facts travel with the narrative so the document is consistent", out)
	}
	if f.ai.calls != 1 {
		t.Errorf("model calls = %d", f.ai.calls)
	}
}

func TestBrief_RulesAndErrors(t *testing.T) {
	f := setup(t, false)
	if c := f.h.Do("POST", "/api/v1/environments/"+f.w.EnvID.String()+"/brief/narrative", f.owner, map[string]any{}).Code; c != http.StatusServiceUnavailable {
		t.Errorf("narrative without an LLM = %d, want 503 (the template report still works)", c)
	}
	if c := f.h.Do("GET", "/api/v1/environments/"+uuid.NewString()+"/brief", f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("unknown environment = %d", c)
	}
	if c := f.h.Do("GET", "/api/v1/environments/"+f.w.EnvID.String()+"/brief", "", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("anonymous = %d", c)
	}
	// a viewer may read the report: it is a read
	viewer := f.h.Login("v@x.com", "viewer")
	if c := f.h.Do("GET", "/api/v1/environments/"+f.w.EnvID.String()+"/brief", viewer, nil).Code; c != http.StatusOK {
		t.Errorf("viewer = %d, want 200", c)
	}
	bad := setup(t, true)
	bad.ai.reply = `{"executive_summary":"x","sections":[],"recommendations":["a"]}`
	if c := bad.h.Do("POST", "/api/v1/environments/"+bad.w.EnvID.String()+"/brief/narrative", bad.owner, map[string]any{}).Code; c != http.StatusBadGateway {
		t.Errorf("a model that breaks the format = %d, want 502", c)
	}
}
