package brief

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/report"
)

type world struct {
	in    input
	nodes map[string]uuid.UUID
}

func node(w *world, key, kind, label string, roles ...string) {
	id := uuid.New()
	w.nodes[key] = id
	w.in.Nodes = append(w.in.Nodes, graph.Node{ID: id, Kind: kind, Label: label, AppRoles: roles, Metadata: []byte(`{}`)})
}

func edge(w *world, from, to, action string) {
	w.in.Edges = append(w.in.Edges, graph.Edge{FromNodeID: w.nodes[from], ToNodeID: w.nodes[to], Action: []byte(action)})
}

func req(w *world, spec, source, key, text, crit string, linked ...string) {
	r := reqRow{SpecTitle: spec, Source: source, Key: key, Text: text, Criticality: crit}
	for _, l := range linked {
		r.NodeIDs = append(r.NodeIDs, w.nodes[l])
	}
	w.in.Reqs = append(w.in.Reqs, r)
}

// shop: two users, a list with a "new" modal that calls an endpoint, a detail page, an admin-only page and a page nobody wrote about.
func shop() *world {
	w := &world{nodes: map[string]uuid.UUID{}}
	w.in = input{Now: time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC), Project: "Loja", Env: envInfo{Name: "hml", BaseURL: "https://hml.loja.com", Policy: "block", Kind: "web"}, LLM: true, Storage: true, Runners: 1}
	node(w, "list-a", "page", "/orders", "admin")
	node(w, "list-o", "page", "/orders", "operador")
	node(w, "modal-a", "modal", "/orders › Novo", "admin")
	node(w, "post", "endpoint", "POST /orders", "admin")
	node(w, "show-a", "page", "/orders/:id", "admin")
	node(w, "adm-a", "page", "/admin", "admin")
	node(w, "help-a", "page", "/help", "admin")
	edge(w, "list-a", "modal-a", `{"type":"click","label":"Novo","intent":"open"}`)
	edge(w, "modal-a", "post", `{"type":"request","method":"POST","path":"/orders"}`)
	edge(w, "list-a", "show-a", `{"type":"navigate","label":"Pedido"}`)
	edge(w, "list-a", "adm-a", `{"type":"navigate","label":"Admin"}`)
	req(w, "Regras", "text", "REQ-001", "A advogada vê a lista de pedidos ao entrar no sistema.", "critical", "list-a", "list-o")
	req(w, "Regras", "text", "REQ-002", "O gerente aprova um pedido pendente com um clique.", "high") // linked to nothing
	req(w, "Regras", "text", "REQ-003", "O sistema deve ser rápido e amigável.", "normal", "show-a")  // vague
	req(w, "Varredura automática · hml", "auto", "PAGE /orders", "A tela /orders responde sem erro.", "normal", "list-a", "list-o")
	return w
}

func TestAnalyze_CountsTheMapAndTheUsers(t *testing.T) {
	f := analyze(shop().in)
	if f.Map.Pages != 5 || f.Map.Screens != 4 || f.Map.Modals != 1 || f.Map.Endpoints != 1 {
		t.Errorf("map = %+v, want 5 page nodes in 4 screens (the same route for two users is one screen), 1 modal, 1 endpoint", f.Map)
	}
	if f.Map.ScreensByUser["admin"] != 4 || f.Map.ScreensByUser["operador"] != 1 {
		t.Errorf("screens by user = %v", f.Map.ScreensByUser)
	}
	if len(f.Users) != 2 || f.Users[0] != "admin" || f.Users[1] != "operador" {
		t.Errorf("users = %v", f.Users)
	}
}

func TestAnalyze_CoverageSaysWhatIsLinkedAndWhatIsNot(t *testing.T) {
	f := analyze(shop().in)
	c := f.Coverage
	if c.Requirements != 4 || c.Linked != 3 || len(c.Unlinked) != 1 || c.Unlinked[0].Key != "REQ-002" {
		t.Errorf("requirements = %+v, want REQ-002 as the only one linked to no screen", c)
	}
	if c.PercentRequirements != 75 {
		t.Errorf("percent = %d, want 75", c.PercentRequirements)
	}
	// /admin and /help have no requirement; /orders and /orders/:id do
	if c.Screens != 4 || c.ScreensCovered != 2 || len(c.ScreensWithoutRequirement) != 2 {
		t.Errorf("screens = %+v", c)
	}
	if got := c.ScreensWithoutRequirement; got[0] != "/admin" || got[1] != "/help" {
		t.Errorf("without requirement = %v", got)
	}
}

func TestAnalyze_BuildsCapabilityCoverageFromScreensAndLatestNodeResults(t *testing.T) {
	w := shop()
	w.in.NodeResults = map[uuid.UUID]string{
		w.nodes["list-a"]: "fail",
		w.nodes["list-o"]: "pass",
		w.nodes["show-a"]: "pass",
		w.nodes["adm-a"]:  "skipped",
	}
	f := analyze(w.in)
	if f.Capabilities.Total != 3 || f.Capabilities.Covered != 1 || f.Capabilities.Tested != 2 || f.Capabilities.Failing != 1 {
		t.Fatalf("capabilities summary = %+v", f.Capabilities)
	}
	by := map[string]CapabilityItem{}
	for _, c := range f.Capabilities.List {
		by[c.Key] = c
	}
	if got := by["orders"]; got.Status != "fail" || got.Screens != 2 || got.ScreensCovered != 2 || got.ScreensTested != 2 {
		t.Errorf("orders capability = %+v", got)
	}
	if got := by["admin"]; got.Status != "skipped" || got.ScreensTested != 1 {
		t.Errorf("admin capability = %+v", got)
	}
	if got := by["help"]; got.Status != "untested" || got.ScreensTested != 0 {
		t.Errorf("help capability = %+v", got)
	}
}

func TestAnalyze_AlternativeFlowsAreTheScreensNotEveryUserReaches(t *testing.T) {
	f := analyze(shop().in)
	got := map[string][]string{}
	for _, a := range f.Access {
		got[a.Route] = a.MissingFor
	}
	if len(got) != 3 || len(got["/orders/:id"]) != 1 || got["/orders/:id"][0] != "operador" || got["/admin"][0] != "operador" {
		t.Errorf("access = %+v, want /orders/:id, /admin and /help not reached by operador; /orders is shared", f.Access)
	}
	if _, shared := got["/orders"]; shared {
		t.Error("a screen both users reach is not an alternative flow")
	}
	one := shop()
	one.in.Nodes = append(one.in.Nodes[:1:1], one.in.Nodes[2:]...) // drop the operator's page
	if got := analyze(one.in); len(got.Access) != 0 || len(got.Users) != 1 {
		t.Errorf("with one user there is nothing to compare: %+v", got.Access)
	}
}

func TestAnalyze_JourneysAreScreensWhereSomethingCanBeDone(t *testing.T) {
	f := analyze(shop().in)
	if f.Journeys.Count != 1 || len(f.Journeys.Routes) != 1 || f.Journeys.Routes[0] != "/orders" {
		t.Errorf("journeys = %+v, want only /orders (a modal and an endpoint hang from it; plain links are not a journey)", f.Journeys)
	}
	if len(f.Journeys.WithoutRequirement) != 0 {
		t.Errorf("/orders is covered: %v", f.Journeys.WithoutRequirement)
	}
	w := shop()
	w.in.Reqs = w.in.Reqs[1:] // REQ-001 and the automatic spec go: /orders is covered by nothing
	w.in.Reqs = []reqRow{w.in.Reqs[0]}
	if got := analyze(w.in).Journeys.WithoutRequirement; len(got) != 1 || got[0] != "/orders" {
		t.Errorf("a journey nobody wrote down must be reported: %v", got)
	}
}

func TestAnalyze_FlagsWhatDoesNotMatchBetweenFlowsAndSpecs(t *testing.T) {
	w := shop()
	f := analyze(w.in)
	has := func(code string) *Issue {
		for i := range f.Issues {
			if f.Issues[i].Code == code {
				return &f.Issues[i]
			}
		}
		return nil
	}
	if i := has("requirements_unlinked"); i == nil || i.Severity != "média" {
		t.Errorf("requirement linked to nothing: %+v", i)
	}
	if i := has("screens_without_requirement"); i == nil {
		t.Error("screens nobody wrote about must be reported")
	}
	if i := has("alternative_flows"); i == nil || i.Severity != "baixa" {
		t.Errorf("alternative flows: %+v", i)
	}
	if i := has("requirement_quality"); i == nil {
		t.Error("a vague requirement must be reported")
	}
	if has("no_regression") == nil {
		t.Error("nothing was tested yet: say so")
	}
	// a critical requirement linked to nothing is serious
	w.in.Reqs = append(w.in.Reqs, reqRow{SpecTitle: "Regras", Source: "text", Key: "REQ-009", Text: "Pagamentos são conciliados no fechamento.", Criticality: "critical"})
	for _, i := range analyze(w.in).Issues {
		if i.Code == "requirements_unlinked" && i.Severity != "alta" {
			t.Errorf("a critical requirement with no screen is high severity, got %q", i.Severity)
		}
	}
	// the list comes most serious first
	order := map[string]int{"alta": 0, "média": 1, "baixa": 2}
	for k := 1; k < len(f.Issues); k++ {
		if order[f.Issues[k-1].Severity] > order[f.Issues[k].Severity] {
			t.Errorf("issues not sorted by severity: %+v", f.Issues)
			break
		}
	}
}

func regression(w *world, passed, failed int, failing ...report.RequirementOutcome) *regressionInfo {
	return &regressionInfo{
		ID: uuid.New(), FinishedAt: w.in.Now.Add(-time.Hour), GraphID: uuid.Nil,
		Report: report.Report{Steps: map[string]int{"pass": passed, "fail": failed, "error": 0, "skipped": 0}, Requirements: failing,
			Users: []report.UserOutcome{{User: "admin", Passed: passed, Failed: failed}}},
	}
}

func TestAnalyze_ReportsTheLastRegressionAndItsFailingRequirements(t *testing.T) {
	w := shop()
	w.in.Regression = regression(w, 8, 2,
		report.RequirementOutcome{Key: "REQ-001", Text: "A advogada vê a lista", Criticality: "critical", Outcome: "fail", ByUser: map[string]string{"admin": "pass", "operador": "fail"}},
		report.RequirementOutcome{Key: "REQ-003", Text: "x", Criticality: "normal", Outcome: "pass"})
	f := analyze(w.in)
	r := f.Regression
	if r == nil || r.Passed != 8 || r.Failed != 2 || len(r.FailingRequirements) != 1 || r.FailingRequirements[0].Key != "REQ-001" {
		t.Fatalf("regression = %+v", r)
	}
	if got := r.FailingRequirements[0].FailingUsers; len(got) != 1 || got[0] != "operador" {
		t.Errorf("who it fails for = %v, want operador (the admin passed)", got)
	}
	for _, i := range f.Issues {
		if i.Code == "no_regression" {
			t.Error("there is a regression: it must not say there is none")
		}
		if i.Code == "failing_critical" && i.Severity != "alta" {
			t.Errorf("a critical requirement failing is high severity")
		}
	}
	found := false
	for _, i := range f.Issues {
		found = found || i.Code == "failing_critical"
	}
	if !found {
		t.Error("a failing critical requirement must be an issue")
	}
}

func TestAnalyze_ARegressionOfAnOlderMapIsMarkedStale(t *testing.T) {
	w := shop()
	w.in.GraphID = uuid.New()
	w.in.Regression = regression(w, 5, 0)
	w.in.Regression.GraphID = uuid.New() // another graph than the latest
	f := analyze(w.in)
	if f.Regression == nil || !f.Regression.Stale {
		t.Errorf("the regression ran on another version of the map: %+v", f.Regression)
	}
}

func TestAnalyze_BugsAreSummarizedWithWhoTheyAffect(t *testing.T) {
	w := shop()
	w.in.Bugs = []bugRow{
		{Title: "/orders: HTTP 500", Severity: "critical", Status: "new", Users: []string{"admin", "operador"}},
		{Title: "/admin: HTTP 404", Severity: "normal", Status: "confirmed", Users: []string{"admin"}},
		{Title: "/help: HTTP 500", Severity: "high", Status: "fixed"},
	}
	f := analyze(w.in)
	if f.Bugs.Open != 2 || f.Bugs.Critical != 1 || f.Bugs.Fixed != 1 || len(f.Bugs.List) != 2 {
		t.Errorf("bugs = %+v", f.Bugs)
	}
	if f.Bugs.List[0].Severity != "critical" {
		t.Errorf("the most serious bug comes first: %+v", f.Bugs.List)
	}
	crit := false
	for _, i := range f.Issues {
		crit = crit || (i.Code == "open_critical_bugs" && i.Severity == "alta")
	}
	if !crit {
		t.Error("an open critical bug is high severity")
	}
}

func TestAnalyze_ReadinessSaysWhatIsMissingForATrustworthyRun(t *testing.T) {
	w := shop()
	w.in.LLM, w.in.Storage, w.in.Runners = false, false, 0
	f := analyze(w.in)
	bad := map[string]bool{}
	for _, c := range f.Readiness {
		if !c.OK {
			bad[c.ID] = true
		}
	}
	for _, id := range []string{"llm", "storage", "runner"} {
		if !bad[id] {
			t.Errorf("readiness %q should be failing: %+v", id, f.Readiness)
		}
	}
	if len(analyze(shop().in).Readiness) == 0 || !analyze(shop().in).Readiness[0].OK {
		t.Error("with everything configured the first checks pass")
	}
}

func TestAnalyze_EmptyEnvironmentSaysThereIsNoMapNotZeros(t *testing.T) {
	f := analyze(input{Now: time.Now(), Project: "P", Env: envInfo{Name: "e"}})
	if f.Map.Explored {
		t.Error("nothing explored")
	}
	found := false
	for _, i := range f.Issues {
		found = found || i.Code == "no_map"
	}
	if !found {
		t.Errorf("an environment with no map must say to explore first: %+v", f.Issues)
	}
	if f.Coverage.PercentRequirements != 0 {
		t.Errorf("percent of nothing = %d", f.Coverage.PercentRequirements)
	}
}
