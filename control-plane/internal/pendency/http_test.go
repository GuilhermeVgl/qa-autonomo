package pendency_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/knowledge"
	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/pendency"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fakeLLM struct {
	out   string
	then  []string // replies for the next calls, after out
	err   error
	task  string
	msgs  []llm.Message
	calls int
}

func (f *fakeLLM) Complete(_ context.Context, _ uuid.UUID, task string, msgs []llm.Message, _ bool) (string, error) {
	f.task, f.msgs = task, msgs
	f.calls++
	if f.calls > 1 && len(f.then) >= f.calls-1 {
		return f.then[f.calls-2], f.err
	}
	return f.out, f.err
}

type fx struct {
	h         *testutil.Harness
	owner     string
	projectID uuid.UUID
	envID     uuid.UUID
	specID    uuid.UUID
	graphID   uuid.UUID
	reqs      map[string]uuid.UUID // key -> id
	nodes     map[string]uuid.UUID // label -> id
}

// setup builds: 3 requirements (REQ-001 critical, REQ-002, REQ-003) and a graph with 3 nodes (/orders, /customers, /reports).
func setup(t *testing.T, fake *fakeLLM) *fx {
	t.Helper()
	var c pendency.Completer
	if fake != nil {
		c = fake
	}
	return setupWith(t, c)
}

// setupWith is setup for any completer (nil: no LLM configured).
func setupWith(t *testing.T, c pendency.Completer) *fx {
	t.Helper()
	f := &fx{reqs: map[string]uuid.UUID{}, nodes: map[string]uuid.UUID{}}
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		pendency.Register(mux, mw, pool, c)
		knowledge.Register(mux, mw, pool)
	})
	f.owner = f.h.Login("o@x.com", "owner")
	ctx, org, pool := context.Background(), f.h.OrgID, f.h.Pool

	p, err := project.New(pool).CreateProject(ctx, project.CreateProjectParams{OrganizationID: org, Name: "P"})
	must(t, err)
	f.projectID = p.ID
	e, err := environment.New(pool).CreateEnvironment(ctx, environment.CreateEnvironmentParams{
		OrganizationID: org, ProjectID: p.ID, Name: "hml", BaseUrl: "https://a.com", AllowedHosts: []string{"a.com"}, DestructivePolicy: "block"})
	must(t, err)
	f.envID = e.ID

	sq := spec.New(pool)
	s, err := sq.CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: org, ProjectID: p.ID, Version: 1, SourceType: "text", Title: "v1", ExtractedText: "t"})
	must(t, err)
	f.specID = s.ID
	for _, r := range []struct{ key, text, crit string }{
		{"REQ-001", "Usuário vê a lista de pedidos", "critical"},
		{"REQ-002", "Usuário consulta clientes", "high"},
		{"REQ-003", "Existe tela de faturas", "normal"},
	} {
		row, err := sq.CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: org, SpecID: s.ID, Key: r.key, Text: r.text, Criticality: r.crit, Status: "new"})
		must(t, err)
		f.reqs[r.key] = row.ID
	}

	gq := graph.New(pool)
	g, err := gq.CreateGraph(ctx, graph.CreateGraphParams{OrganizationID: org, ProjectID: p.ID, EnvironmentID: e.ID, Version: 1})
	must(t, err)
	f.graphID = g.ID
	for _, l := range []string{"/orders", "/customers", "/reports"} {
		n, err := gq.UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: org, GraphID: g.ID, Kind: "page", Fingerprint: "fp" + l, Label: l, AppRoles: []string{"admin"}, Metadata: []byte(`{}`)})
		must(t, err)
		f.nodes[l] = n.ID
	}
	return f
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (f *fx) crossref(token string) (int, crossrefResp) {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/api/v1/environments/"+f.envID.String()+"/crossref", token, map[string]any{})
	var out crossrefResp
	if rec.Code == http.StatusOK {
		f.h.JSON(rec, &out)
	}
	return rec.Code, out
}

type crossrefResp struct {
	Links             int `json:"links"`
	PendenciesCreated int `json:"pendencies_created"`
}

type pendencyView struct {
	ID            string  `json:"id"`
	RequirementID string  `json:"requirement_id"`
	NodeID        *string `json:"node_id"`
	Question      string  `json:"question"`
	Status        string  `json:"status"`
	Answer        *string `json:"answer"`
}

func (f *fx) pendencies() []pendencyView {
	f.h.T.Helper()
	var out []pendencyView
	f.h.JSON(f.h.Do("GET", "/api/v1/specs/"+f.specID.String()+"/pendencies", f.owner, nil), &out)
	return out
}

type coverage struct {
	Requirements []struct {
		Key    string `json:"key"`
		Status string `json:"status"`
	} `json:"requirements"`
	Nodes []struct {
		Label           string   `json:"label"`
		Status          string   `json:"status"`
		RequirementKeys []string `json:"requirement_keys"`
	} `json:"nodes"`
}

func (f *fx) coverage() coverage {
	f.h.T.Helper()
	var out coverage
	rec := f.h.Do("GET", "/api/v1/specs/"+f.specID.String()+"/coverage?graph_id="+f.graphID.String(), f.owner, nil)
	if rec.Code != http.StatusOK {
		f.h.T.Fatalf("coverage = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &out)
	return out
}

func (c coverage) req(key string) string {
	for _, r := range c.Requirements {
		if r.Key == key {
			return r.Status
		}
	}
	return "missing"
}

func (c coverage) node(label string) (string, []string) {
	for _, n := range c.Nodes {
		if n.Label == label {
			return n.Status, n.RequirementKeys
		}
	}
	return "missing", nil
}

// n1=/orders n2=/customers n3=/reports in the prompt (listing order is creation order).
const goodOutput = `{"links":[{"requirement":"REQ-001","node":"n1","confidence":0.9},{"requirement":"REQ-002","node":"n2","confidence":0.7}],"pendencies":[]}`

func TestCrossref_LinksRequirementsAndRaisesPendencyForTheUnmatched(t *testing.T) {
	fake := &fakeLLM{out: goodOutput}
	f := setup(t, fake)
	code, got := f.crossref(f.owner)
	if code != http.StatusOK || got.Links != 2 || got.PendenciesCreated != 1 {
		t.Fatalf("crossref = %d %+v", code, got)
	}
	if fake.task != "plan" {
		t.Errorf("task = %q", fake.task)
	}

	cov := f.coverage()
	if cov.req("REQ-001") != "covered" || cov.req("REQ-002") != "covered" || cov.req("REQ-003") != "pending" {
		t.Errorf("requirements = %+v", cov.Requirements)
	}
	if st, keys := cov.node("/orders"); st != "covered" || len(keys) != 1 || keys[0] != "REQ-001" {
		t.Errorf("/orders = %s %v", st, keys)
	}
	if st, _ := cov.node("/reports"); st != "no_spec" {
		t.Errorf("/reports = %s, want no_spec", st)
	}

	ps := f.pendencies()
	if len(ps) != 1 || ps[0].Status != "open" || ps[0].RequirementID != f.reqs["REQ-003"].String() || ps[0].Question == "" {
		t.Errorf("pendencies = %+v", ps)
	}
}

func TestCrossref_PromptTreatsAppContentAsDataAndHidesIDs(t *testing.T) {
	fake := &fakeLLM{out: goodOutput}
	f := setup(t, fake)
	_, err := knowledge.New(f.h.Pool).CreateKnowledge(context.Background(), knowledge.CreateKnowledgeParams{
		OrganizationID: f.h.OrgID, ProjectID: f.projectID, Content: "Faturas ficam em /reports", Origin: "manual"})
	must(t, err)
	f.crossref(f.owner)

	system, user := fake.msgs[0].Content, fake.msgs[1].Content
	if !strings.Contains(system, "dados") {
		t.Error("system prompt must say app/spec content is data, not instructions")
	}
	for _, want := range []string{"REQ-001", "Usuário vê a lista de pedidos", "/orders", "n1", "Faturas ficam em /reports"} {
		if !strings.Contains(user, want) {
			t.Errorf("prompt is missing %q", want)
		}
	}
	for id := range f.nodes {
		if strings.Contains(user, f.nodes[id].String()) {
			t.Error("prompt must not expose node UUIDs")
		}
	}
}

func TestCrossref_PromptCarriesWhatTheAgentLearnedAboutEachScreen(t *testing.T) {
	fake := &fakeLLM{out: goodOutput}
	f := setup(t, fake)
	ctx := context.Background()
	rich := `{"status":200,"summary":"Formulário de cadastro de cliente.","forms":[{"label":"Novo cliente","method":"POST","action":"/clients","purpose":"Cadastrar cliente"}],` +
		`"actions":[{"label":"Salvar","kind":"submit-valid","intent":"save","requests":["POST /clients → 302"]},{"label":"Remover","intent":"delete","requests":["DELETE /clients/{id} (bloqueada pela política)"]}]}`
	_, err := graph.New(f.h.Pool).UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: f.h.OrgID, GraphID: f.graphID, Kind: "page", Fingerprint: "fp/clients/new", Label: "/clients/new", AppRoles: []string{"admin"}, Metadata: []byte(rich)})
	must(t, err)
	huge := `{"summary":"` + strings.Repeat("x", 5000) + `"}`
	_, err = graph.New(f.h.Pool).UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: f.h.OrgID, GraphID: f.graphID, Kind: "page", Fingerprint: "fp/huge", Label: "/huge", AppRoles: []string{"admin"}, Metadata: []byte(huge)})
	must(t, err)

	f.crossref(f.owner)
	user := fake.msgs[1].Content
	for _, want := range []string{"/clients/new", "Formulário de cadastro de cliente.", "Novo cliente (POST /clients)", "Salvar", "POST /clients → 302", "DELETE /clients/{id}"} {
		if !strings.Contains(user, want) {
			t.Errorf("prompt is missing %q:\n%s", want, user)
		}
	}
	if strings.Contains(user, strings.Repeat("x", 600)) {
		t.Error("what the agent learned about one screen must be cut to a short note")
	}
	if !strings.Contains(user, "<nos>") || strings.Index(user, "Formulário de cadastro") < strings.Index(user, "<nos>") || strings.Index(user, "Formulário de cadastro") > strings.Index(user, "</nos>") {
		t.Error("the notes belong inside the <nos> data block")
	}
	for _, id := range f.nodes {
		if strings.Contains(user, id.String()) {
			t.Error("prompt must not expose node UUIDs")
		}
	}
}

func TestCrossref_RerunIsIdempotentAndKeepsHumanLinks(t *testing.T) {
	fake := &fakeLLM{out: goodOutput}
	f := setup(t, fake)
	f.crossref(f.owner)
	// a human links the unmatched requirement to /reports
	p := f.pendencies()[0]
	rec := f.h.Do("POST", "/api/v1/pendencies/"+p.ID+"/answer", f.owner, map[string]any{"answer": "Faturas ficam em Relatórios", "node_id": f.nodes["/reports"]})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer = %d %s", rec.Code, rec.Body)
	}
	// the LLM now (wrongly) matches nothing: agent links vanish, the human link stays
	fake.out = `{"links":[],"pendencies":[]}`
	if code, got := f.crossref(f.owner); code != http.StatusOK || got.Links != 0 {
		t.Fatalf("rerun = %d %+v", code, got)
	}
	cov := f.coverage()
	if cov.req("REQ-003") != "covered" {
		t.Errorf("human link lost: %+v", cov.Requirements)
	}
	// REQ-001/002 lost their agent links and are pending again, exactly one open pendency each
	if cov.req("REQ-001") != "pending" || cov.req("REQ-002") != "pending" {
		t.Errorf("requirements = %+v", cov.Requirements)
	}
	open := 0
	for _, p := range f.pendencies() {
		if p.Status == "open" {
			open++
		}
	}
	if open != 2 {
		t.Errorf("open pendencies = %d, want 2", open)
	}
	// same output again changes nothing
	f.crossref(f.owner)
	open = 0
	for _, p := range f.pendencies() {
		if p.Status == "open" {
			open++
		}
	}
	if open != 2 {
		t.Errorf("rerun duplicated pendencies: %d open", open)
	}
}

func TestCrossref_LLMPendencyAnchoredToNode(t *testing.T) {
	fake := &fakeLLM{out: `{"links":[{"requirement":"REQ-001","node":"n1","confidence":0.5}],"pendencies":[{"requirement":"REQ-001","node":"n3","question":"Pedidos também aparecem em /reports?"}]}`}
	f := setup(t, fake)
	f.crossref(f.owner)
	var anchored *pendencyView
	for _, p := range f.pendencies() {
		if p.Question == "Pedidos também aparecem em /reports?" {
			p := p
			anchored = &p
		}
	}
	if anchored == nil || anchored.NodeID == nil || *anchored.NodeID != f.nodes["/reports"].String() {
		t.Fatalf("anchored pendency = %+v", anchored)
	}
}

func TestCrossref_ClosesPendencyWhenRequirementGetsLinked(t *testing.T) {
	fake := &fakeLLM{out: `{"links":[],"pendencies":[]}`}
	f := setup(t, fake)
	f.crossref(f.owner)
	if n := len(f.pendencies()); n != 3 {
		t.Fatalf("pendencies = %d, want 3", n)
	}
	fake.out = `{"links":[{"requirement":"REQ-003","node":"n3","confidence":0.8}],"pendencies":[]}`
	f.crossref(f.owner)
	for _, p := range f.pendencies() {
		if p.RequirementID == f.reqs["REQ-003"].String() && p.Status != "dismissed" {
			t.Errorf("pendency of a now-linked requirement is %q, want dismissed", p.Status)
		}
	}
}

func TestCrossref_RejectsInvalidLLMOutputWithoutStoringAnything(t *testing.T) {
	for name, out := range map[string]string{
		"not json":            `nope`,
		"unknown node":        `{"links":[{"requirement":"REQ-001","node":"n99","confidence":0.5}],"pendencies":[]}`,
		"unknown requirement": `{"links":[{"requirement":"REQ-999","node":"n1","confidence":0.5}],"pendencies":[]}`,
		"confidence > 1":      `{"links":[{"requirement":"REQ-001","node":"n1","confidence":1.5}],"pendencies":[]}`,
		"empty question":      `{"links":[],"pendencies":[{"requirement":"REQ-001","question":" "}]}`,
		"unknown field":       `{"links":[],"pendencies":[],"x":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			f := setup(t, &fakeLLM{out: out})
			if code, _ := f.crossref(f.owner); code != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502", code)
			}
			if n := len(f.pendencies()); n != 0 {
				t.Errorf("stored %d pendencies from invalid output", n)
			}
		})
	}
}

func TestCrossref_AsksTheModelAgainOnceWhenTheFirstReplyIsInvalid(t *testing.T) {
	fake := &fakeLLM{out: "```json\n{ not valid\n```", then: []string{goodOutput}}
	f := setup(t, fake)
	if code, body := f.crossref(f.owner); code != http.StatusOK {
		t.Fatalf("status = %d %+v, want 200 after the second reply", code, body)
	}
	if fake.calls != 2 {
		t.Errorf("model calls = %d, want 2", fake.calls)
	}
	if n := len(fake.msgs); n != 4 || fake.msgs[2].Role != "assistant" {
		t.Errorf("the second call must carry the bad reply and the correction: %+v", fake.msgs)
	}

	bad := &fakeLLM{out: "nope", then: []string{"still nope", "never asked a third time"}}
	g := setup(t, bad)
	if code, _ := g.crossref(g.owner); code != http.StatusBadGateway || bad.calls != 2 {
		t.Errorf("two invalid replies: status = %d, calls = %d, want 502 after exactly 2", code, bad.calls)
	}
}

func TestCrossref_Preconditions(t *testing.T) {
	f := setup(t, &fakeLLM{out: goodOutput})
	zero := "00000000-0000-0000-0000-000000000000"
	if c := f.h.Do("POST", "/api/v1/environments/"+zero+"/crossref", f.owner, map[string]any{}).Code; c != http.StatusNotFound {
		t.Errorf("unknown env = %d, want 404", c)
	}
	viewer := f.h.Login("v@x.com", "viewer")
	if code, _ := f.crossref(viewer); code != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", code)
	}
	if c := f.h.Do("POST", "/api/v1/environments/"+f.envID.String()+"/crossref", f.owner, map[string]any{"spec_id": zero}).Code; c != http.StatusNotFound {
		t.Errorf("unknown spec = %d, want 404", c)
	}

	noLLM := setup(t, nil)
	if code, _ := noLLM.crossref(noLLM.owner); code != http.StatusServiceUnavailable {
		t.Errorf("no LLM = %d, want 503", code)
	}
}

func TestAnswer_WithNodeCreatesHumanLinkKnowledgeAndAudit(t *testing.T) {
	f := setup(t, &fakeLLM{out: goodOutput})
	f.crossref(f.owner)
	p := f.pendencies()[0] // REQ-003

	rec := f.h.Do("POST", "/api/v1/pendencies/"+p.ID+"/answer", f.owner, map[string]any{"answer": "Faturas ficam em Relatórios", "node_id": f.nodes["/reports"]})
	if rec.Code != http.StatusOK {
		t.Fatalf("answer = %d %s", rec.Code, rec.Body)
	}
	cov := f.coverage()
	if cov.req("REQ-003") != "covered" {
		t.Errorf("REQ-003 = %s", cov.req("REQ-003"))
	}
	if st, keys := cov.node("/reports"); st != "covered" || len(keys) != 1 || keys[0] != "REQ-003" {
		t.Errorf("/reports = %s %v", st, keys)
	}

	var links struct{ Source string }
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT source FROM requirement_links WHERE requirement_id = $1`, f.reqs["REQ-003"]).Scan(&links.Source); err != nil || links.Source != "human" {
		t.Errorf("link source = %q, %v", links.Source, err)
	}

	var know []struct {
		Content string `json:"content"`
		Origin  string `json:"origin"`
	}
	f.h.JSON(f.h.Do("GET", "/api/v1/projects/"+f.projectID.String()+"/knowledge", f.owner, nil), &know)
	if len(know) != 1 || know[0].Origin != "pendency" || !strings.Contains(know[0].Content, "Faturas ficam em Relatórios") {
		t.Errorf("knowledge = %+v", know)
	}

	entries, _ := audit.New(f.h.Pool).ListAudit(context.Background(), audit.ListAuditParams{OrganizationID: f.h.OrgID, Limit: 20})
	found := false
	for _, e := range entries {
		found = found || e.Action == "pendency.answer"
	}
	if !found {
		t.Error("pendency.answer was not audited")
	}
}

func TestAnswer_WithoutNodeKeepsRequirementUnmatched(t *testing.T) {
	f := setup(t, &fakeLLM{out: goodOutput})
	f.crossref(f.owner)
	p := f.pendencies()[0]
	if c := f.h.Do("POST", "/api/v1/pendencies/"+p.ID+"/answer", f.owner, map[string]any{"answer": "Ainda não existe, será feito no próximo mês"}).Code; c != http.StatusOK {
		t.Fatalf("answer = %d", c)
	}
	if got := f.coverage().req("REQ-003"); got != "unmatched" {
		t.Errorf("REQ-003 = %s, want unmatched (answered, no node)", got)
	}
}

func TestAnswerAndDismiss_Rules(t *testing.T) {
	f := setup(t, &fakeLLM{out: goodOutput})
	f.crossref(f.owner)
	p := f.pendencies()[0]
	path := "/api/v1/pendencies/" + p.ID
	zero := "00000000-0000-0000-0000-000000000000"

	if c := f.h.Do("POST", path+"/answer", f.owner, map[string]any{"answer": "  "}).Code; c != http.StatusBadRequest {
		t.Errorf("blank answer = %d, want 400", c)
	}
	if c := f.h.Do("POST", path+"/answer", f.owner, map[string]any{"answer": "x", "node_id": zero}).Code; c != http.StatusBadRequest {
		t.Errorf("unknown node = %d, want 400", c)
	}
	if c := f.h.Do("POST", "/api/v1/pendencies/"+zero+"/answer", f.owner, map[string]any{"answer": "x"}).Code; c != http.StatusNotFound {
		t.Errorf("unknown pendency = %d, want 404", c)
	}
	viewer := f.h.Login("v@x.com", "viewer")
	if c := f.h.Do("POST", path+"/answer", viewer, map[string]any{"answer": "x"}).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
	if c := f.h.Do("POST", path+"/dismiss", f.owner, nil).Code; c != http.StatusOK {
		t.Fatalf("dismiss = %d", c)
	}
	if c := f.h.Do("POST", path+"/dismiss", f.owner, nil).Code; c != http.StatusConflict {
		t.Errorf("dismiss twice = %d, want 409", c)
	}
	if c := f.h.Do("POST", path+"/answer", f.owner, map[string]any{"answer": "x"}).Code; c != http.StatusConflict {
		t.Errorf("answer after dismiss = %d, want 409", c)
	}
}

func TestCoverage_Validation(t *testing.T) {
	f := setup(t, &fakeLLM{out: goodOutput})
	base := "/api/v1/specs/" + f.specID.String() + "/coverage"
	if c := f.h.Do("GET", base, f.owner, nil).Code; c != http.StatusBadRequest {
		t.Errorf("missing graph_id = %d, want 400", c)
	}
	if c := f.h.Do("GET", base+"?graph_id=00000000-0000-0000-0000-000000000000", f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("unknown graph = %d, want 404", c)
	}
	if c := f.h.Do("GET", "/api/v1/specs/00000000-0000-0000-0000-000000000000/coverage?graph_id="+f.graphID.String(), f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("unknown spec = %d, want 404", c)
	}
}

// batchLLM answers every call by linking the first requirement it is shown to the first node it is shown.
type batchLLM struct {
	calls   int
	prompts []string
}

func (b *batchLLM) Complete(_ context.Context, _ uuid.UUID, _ string, msgs []llm.Message, _ bool) (string, error) {
	b.calls++
	user := msgs[len(msgs)-1].Content
	b.prompts = append(b.prompts, user)
	after := strings.SplitN(strings.SplitN(user, "<requisitos>\n", 2)[1], " [", 2)[0]
	return `{"links":[{"requirement":"` + after + `","node":"n1","confidence":0.9}],"pendencies":[]}`, nil
}

func TestCrossref_ABigSpecAndABigMapAreReadInBatches(t *testing.T) {
	fake := &batchLLM{}
	f := setupWith(t, fake)
	ctx := context.Background()
	sq := spec.New(f.h.Pool)
	for i := 4; i <= 60; i++ {
		_, err := sq.CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: f.h.OrgID, SpecID: f.specID, Key: "REQ-" + pad3(i), Text: "Regra genérica " + pad3(i), Criticality: "normal", Status: "new"})
		must(t, err)
	}
	gq := graph.New(f.h.Pool)
	for i := 0; i < 400; i++ {
		label := "/area" + pad3(i) + "/lista"
		if i == 350 {
			label = "/faturas/emitidas"
		}
		_, err := gq.UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: f.h.OrgID, GraphID: f.graphID, Kind: "page", Fingerprint: "fpx" + label, Label: label, AppRoles: []string{"admin"}, Metadata: []byte(`{}`)})
		must(t, err)
	}

	code, got := f.crossref(f.owner)
	if code != http.StatusOK {
		t.Fatalf("crossref = %d", code)
	}
	if fake.calls != 3 { // 60 requirements, 25 per call
		t.Errorf("model calls = %d, want 3 (25 + 25 + 10 requirements)", fake.calls)
	}
	if got.Links != 3 {
		t.Errorf("links = %d, want one per batch merged", got.Links)
	}
	// REQ-003 ("Existe tela de faturas") is in the first batch: the invoices screen, far past the old limit of 300, is offered
	if !strings.Contains(fake.prompts[0], "/faturas/emitidas") {
		t.Errorf("the node the requirement is about must reach the model, however deep it is in the map")
	}
	for i, p := range fake.prompts {
		if n := strings.Count(p, "\nn"); n > 100 {
			t.Errorf("prompt %d lists %d nodes: a batch must stay small enough for a small model", i, n)
		}
	}
}

func pad3(i int) string { return strings.Repeat("0", 3-len(itoa(i))) + itoa(i) }

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var d []byte
	for ; i > 0; i /= 10 {
		d = append([]byte{byte('0' + i%10)}, d...)
	}
	return string(d)
}
