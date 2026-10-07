package autospec_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/autospec"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

const clientsNew = `{"status":200,"summary":"Cadastro de cliente.","forms":[
 {"label":"Novo cliente","method":"POST","action":"/clients","purpose":"Cadastrar","fields":[{"name":"client[name]","type":"text","required":true}]},
 {"label":"Busca","method":"GET","action":"/clients","purpose":"Buscar","fields":[{"name":"q","type":"search","required":false}]},
 {"label":"Entrar","method":"POST","action":"/session","purpose":"Login","fields":[{"name":"password","type":"password","required":true}]}]}`

const observedEndpoint = `{"source":"observed","observed":{"statuses":[302],"blocked":false,"fields":["client[name]"]}}`

type fixture struct {
	h     *testutil.Harness
	owner string
	w     *testutil.World
}

func setup(t *testing.T) *fixture {
	t.Helper()
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		spec.Register(mux, mw, pool, nil)
		autospec.Register(mux, mw, pool)
	})
	f := &fixture{h: h, owner: h.Login("o@x.com", "owner")}
	f.w = h.SeedWorld() // pages /orders /customers /reports (REQ-001, REQ-002 from a text spec)
	f.addNode("page", "/clients/new", "fp/clients/new", clientsNew)
	f.addNode("endpoint", "POST /clients", "POST /clients", observedEndpoint)
	return f
}

func (f *fixture) addNode(kind, label, fp, meta string) uuid.UUID {
	f.h.T.Helper()
	n, err := graph.New(f.h.Pool).UpsertNode(context.Background(), graph.UpsertNodeParams{OrganizationID: f.h.OrgID, GraphID: f.w.GraphID, Kind: kind, Fingerprint: fp, Label: label, AppRoles: []string{"admin"}, Metadata: []byte(meta)})
	if err != nil {
		f.h.T.Fatal(err)
	}
	return n.ID
}

type result struct {
	SpecID    string `json:"spec_id"`
	Version   int    `json:"version"`
	Created   int    `json:"created"`
	Updated   int    `json:"updated"`
	Unchanged int    `json:"unchanged"`
	Removed   int    `json:"removed"`
}

func (f *fixture) generate() (int, result) {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/api/v1/environments/"+f.w.EnvID.String()+"/specs/auto", f.owner, map[string]any{})
	var out result
	if rec.Code < 300 {
		f.h.JSON(rec, &out)
	}
	return rec.Code, out
}

type reqRow struct {
	Key         string `json:"key"`
	Text        string `json:"text"`
	Criticality string `json:"criticality"`
	Status      string `json:"status"`
}

func (f *fixture) requirements(specID string) map[string]reqRow {
	f.h.T.Helper()
	var rows []reqRow
	f.h.JSON(f.h.Do("GET", "/api/v1/specs/"+specID+"/requirements", f.owner, nil), &rows)
	out := map[string]reqRow{}
	for _, r := range rows {
		out[r.Key] = r
	}
	return out
}

func (f *fixture) linkedLabels(specID, key string) []string {
	f.h.T.Helper()
	rows, err := f.h.Pool.Query(context.Background(), `SELECT n.label FROM requirement_links l JOIN requirements r ON r.id = l.requirement_id JOIN nodes n ON n.id = l.node_id WHERE r.spec_id = $1 AND r.key = $2 ORDER BY n.label`, specID, key)
	if err != nil {
		f.h.T.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var l string
		_ = rows.Scan(&l)
		out = append(out, l)
	}
	return out
}

func TestGenerate_OneRequirementPerScreenAndPerFormAndLinksThem(t *testing.T) {
	f := setup(t)
	code, res := f.generate()
	if code != http.StatusCreated {
		t.Fatalf("generate = %d", code)
	}
	var sourceType, title string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT source_type, title FROM specs WHERE id = $1`, res.SpecID).Scan(&sourceType, &title); err != nil {
		t.Fatal(err)
	}
	if sourceType != "auto" || title != "Varredura automática · hml" {
		t.Errorf("spec = %q %q", sourceType, title)
	}

	reqs := f.requirements(res.SpecID)
	for _, key := range []string{"PAGE /orders", "PAGE /customers", "PAGE /reports", "PAGE /clients/new", "FORM POST /clients", "FORM GET /clients", "VALIDATE POST /clients"} {
		if _, ok := reqs[key]; !ok {
			t.Errorf("missing requirement %q (have %v)", key, reqs)
		}
	}
	if len(reqs) != 7 {
		t.Errorf("requirements = %d, want 7: %v", len(reqs), reqs)
	}
	for key := range reqs {
		if key == "FORM POST /session" || key == "CALL POST /clients" {
			t.Errorf("%q must not be generated (password forms are never tried; observed endpoints have no check of their own)", key)
		}
	}
	if reqs["FORM POST /clients"].Criticality != "high" || reqs["PAGE /orders"].Criticality != "normal" || reqs["FORM GET /clients"].Criticality != "normal" {
		t.Errorf("criticality: %+v", reqs)
	}
	if reqs["PAGE /orders"].Status != "new" {
		t.Errorf("first generation: status = %q, want new", reqs["PAGE /orders"].Status)
	}
	if got := reqs["PAGE /clients/new"].Text; got == "" || !contains(got, "Cadastro de cliente.") {
		t.Errorf("the screen's own description belongs in the requirement text, got %q", got)
	}
	if got := f.linkedLabels(res.SpecID, "PAGE /orders"); len(got) != 1 || got[0] != "/orders" {
		t.Errorf("PAGE /orders linked to %v", got)
	}
	if got := f.linkedLabels(res.SpecID, "FORM POST /clients"); len(got) != 1 || got[0] != "/clients/new" {
		t.Errorf("a form is linked to the screen it lives on, got %v", got)
	}
	if got := f.linkedLabels(res.SpecID, "VALIDATE POST /clients"); len(got) != 1 || got[0] != "/clients/new" {
		t.Errorf("a validation check is linked to the screen of its form, got %v", got)
	}
}

func TestGenerate_AFormWithRequiredFieldsGetsAValidationRequirement(t *testing.T) {
	f := setup(t)
	f.addNode("page", "/matters/new", "fp/matters/new", `{"forms":[
	 {"label":"Novo processo","method":"POST","action":"/matters","fields":[{"name":"matter[number]","label":"Número","type":"text","required":true},{"name":"matter[notes]","label":"Notas","type":"text","required":false},{"name":"token","type":"hidden","required":true}]},
	 {"label":"Salvar rascunho","method":"PUT","action":"/matters/1","fields":[{"name":"m","type":"text","required":false}]},
	 {"label":"Remover","method":"DELETE","action":"/matters/1","fields":[{"name":"x","type":"text","required":true}]},
	 {"label":"Anexar","method":"POST","action":"/matters/1/files","fields":[{"name":"f","type":"file","required":true}]}]}`)
	_, res := f.generate()
	reqs := f.requirements(res.SpecID)
	v, ok := reqs["VALIDATE POST /matters"]
	if !ok {
		t.Fatalf("a POST form with a required field must get a validation requirement: %v", reqs)
	}
	if v.Criticality != "normal" || !contains(v.Text, "Número") || contains(v.Text, "Notas") || contains(v.Text, "token") {
		t.Errorf("validation requirement = %+v, want to name the required visible field only", v)
	}
	for _, key := range []string{"VALIDATE PUT /matters/1", "VALIDATE DELETE /matters/1", "VALIDATE POST /matters/1/files"} {
		if _, bad := reqs[key]; bad {
			t.Errorf("%q must not exist: nothing required to check, a delete has no data, a file field is never filled", key)
		}
	}
}

func TestGenerate_RequirementsSayWhatTheAgentSawAndForWhichUsers(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	// the operator reaches /orders too (with fewer actions); /reports stays the admin's
	if _, err := graph.New(f.h.Pool).UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: f.h.OrgID, GraphID: f.w.GraphID, Kind: "page", Fingerprint: "fp/orders/op", Label: "/orders", AppRoles: []string{"operador"}, Metadata: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.h.Pool.Exec(ctx, `UPDATE nodes SET metadata = $2 WHERE id = $1`, f.w.Nodes["/orders"], `{"title":"Pedidos","controls":[{"label":"Exportar"},{"label":"Excluir pedido"},{"label":"Filtrar"},{"label":"Novo"},{"label":"Ajuda"},{"label":"Sexto"}]}`); err != nil {
		t.Fatal(err)
	}
	_, res := f.generate()
	reqs := f.requirements(res.SpecID)
	orders := reqs["PAGE /orders"].Text
	for _, want := range []string{"admin, operador", "Pedidos", "Exportar", "Excluir pedido"} {
		if !contains(orders, want) {
			t.Errorf("PAGE /orders must mention %q, got %q", want, orders)
		}
	}
	if contains(orders, "Sexto") {
		t.Errorf("only the first few actions are listed: %q", orders)
	}
	if got := reqs["PAGE /reports"].Text; !contains(got, "Só alcançada por: admin") {
		t.Errorf("a screen only some users reach says so (an alternative flow), got %q", got)
	}
	if got := reqs["PAGE /orders"].Text; contains(got, "Só alcançada") {
		t.Errorf("a screen every user reaches must not say that: %q", got)
	}
	// with a single user nothing about users is said
	f2 := setup(t)
	_, r2 := f2.generate()
	if got := f2.requirements(r2.SpecID)["PAGE /reports"].Text; contains(got, "usuários") || contains(got, "Só alcançada") {
		t.Errorf("one user: no talk of users, got %q", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestGenerate_AgainKeepsTheSameSpecAndOnlyReportsWhatChanged(t *testing.T) {
	f := setup(t)
	_, first := f.generate()

	code, again := f.generate()
	if code != http.StatusOK {
		t.Fatalf("second generate = %d, want 200 (the spec already exists)", code)
	}
	if again.SpecID != first.SpecID || again.Version != first.Version {
		t.Errorf("a new spec appeared: %+v vs %+v", again, first)
	}
	if again.Created != 0 || again.Updated != 0 || again.Removed != 0 || again.Unchanged != 7 {
		t.Errorf("nothing changed, got %+v", again)
	}
	if st := f.requirements(again.SpecID)["PAGE /orders"].Status; st != "unchanged" {
		t.Errorf("status after an identical regeneration = %q, want unchanged", st)
	}

	// the app grew a form and a screen lost one: new requirement, changed text, removed requirement
	f.addNode("page", "/matters", "fp/matters", `{"forms":[{"label":"Novo processo","method":"POST","action":"/matters","fields":[{"name":"n","type":"text"}]}]}`)
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE nodes SET metadata = $2 WHERE id = $1`, f.w.Nodes["/reports"], `{"summary":"Relatórios mensais"}`); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`DELETE FROM requirement_links WHERE node_id = $1`, `DELETE FROM nodes WHERE id = $1`} {
		if _, err := f.h.Pool.Exec(context.Background(), q, f.w.Nodes["/customers"]); err != nil {
			t.Fatal(err)
		}
	}
	_, third := f.generate()
	if third.Created != 2 || third.Updated != 1 || third.Removed != 1 { // PAGE /matters + FORM POST /matters; PAGE /reports text; PAGE /customers
		t.Errorf("third = %+v", third)
	}
	reqs := f.requirements(third.SpecID)
	if _, gone := reqs["PAGE /customers"]; gone {
		t.Error("the requirement of a screen that disappeared must be removed")
	}
	if reqs["PAGE /reports"].Status != "changed" || reqs["PAGE /matters"].Status != "new" {
		t.Errorf("statuses: %+v", reqs)
	}
}

func TestGenerate_LeavesTheUsersOwnSpecsAlone(t *testing.T) {
	f := setup(t)
	f.generate()
	var n int
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT count(*) FROM requirement_links WHERE requirement_id = $1`, f.w.Reqs["REQ-001"]).Scan(&n); err != nil || n != 1 {
		t.Errorf("REQ-001 of the text spec lost its link: n=%d err=%v", n, err)
	}
	var specs int
	_ = f.h.Pool.QueryRow(context.Background(), `SELECT count(*) FROM specs WHERE project_id = $1`, f.w.ProjectID).Scan(&specs)
	if specs != 2 {
		t.Errorf("specs = %d, want the user's plus the generated one", specs)
	}
}

func TestGenerate_NeedsAMapAndAWriter(t *testing.T) {
	h := testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		spec.Register(mux, mw, pool, nil)
		autospec.Register(mux, mw, pool)
	})
	owner := h.Login("o@x.com", "owner")
	w := h.SeedWorld()
	if _, err := h.Pool.Exec(context.Background(), `DELETE FROM requirement_links WHERE organization_id = $1`, h.OrgID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Pool.Exec(context.Background(), `DELETE FROM nodes WHERE graph_id = $1`, w.GraphID); err != nil {
		t.Fatal(err)
	}
	// an empty map has nothing to describe
	if c := h.Do("POST", "/api/v1/environments/"+w.EnvID.String()+"/specs/auto", owner, map[string]any{}).Code; c != http.StatusConflict {
		t.Errorf("empty map = %d, want 409", c)
	}
	if c := h.Do("POST", "/api/v1/environments/"+uuid.NewString()+"/specs/auto", owner, map[string]any{}).Code; c != http.StatusNotFound {
		t.Errorf("unknown environment = %d, want 404", c)
	}
	viewer := h.Login("v@x.com", "viewer")
	if c := h.Do("POST", "/api/v1/environments/"+w.EnvID.String()+"/specs/auto", viewer, map[string]any{}).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
}

func TestGenerate_TheGeneratedSpecIsNeverTheLatestSpecOfTheProject(t *testing.T) {
	f := setup(t)
	if code, _ := f.generate(); code != http.StatusCreated {
		t.Fatalf("generate = %d", code)
	}
	// the default crossref and the diff of a new upload work against what people wrote, not against the sweep
	latest, err := spec.New(f.h.Pool).GetLatestSpec(context.Background(), spec.GetLatestSpecParams{OrganizationID: f.h.OrgID, ProjectID: f.w.ProjectID})
	if err != nil {
		t.Fatal(err)
	}
	if latest.ID != f.w.SpecID {
		t.Errorf("latest spec = %s, want the user's spec %s", latest.ID, f.w.SpecID)
	}
}

func TestGenerate_EveryEnvironmentHasItsOwnAutomaticSpec(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	_, first := f.generate()

	// a second environment of the same project, with its own map
	var env2, graph2 uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO environments (organization_id, project_id, name, base_url, allowed_hosts, destructive_policy) VALUES ($1, $2, 'lab', 'https://lab.a.com', '{lab.a.com}', 'block') RETURNING id`, f.h.OrgID, f.w.ProjectID).Scan(&env2); err != nil {
		t.Fatal(err)
	}
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO graphs (organization_id, project_id, environment_id, version) VALUES ($1, $2, $3, 1) RETURNING id`, f.h.OrgID, f.w.ProjectID, env2).Scan(&graph2); err != nil {
		t.Fatal(err)
	}
	if _, err := graph.New(f.h.Pool).UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: f.h.OrgID, GraphID: graph2, Kind: "page", Fingerprint: "fp/lab", Label: "/lab", AppRoles: []string{"admin"}, Metadata: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}

	rec := f.h.Do("POST", "/api/v1/environments/"+env2.String()+"/specs/auto", f.owner, map[string]any{})
	if rec.Code != http.StatusCreated {
		t.Fatalf("generate for the second environment = %d %s (it must create its own spec, not reuse the first's)", rec.Code, rec.Body)
	}
	var second result
	f.h.JSON(rec, &second)
	if second.SpecID == first.SpecID {
		t.Fatal("two environments must not share one automatic spec")
	}
	// each describes only its own map, and exploring one never rewrites the other
	if _, ok := f.requirements(second.SpecID)["PAGE /lab"]; !ok || len(f.requirements(second.SpecID)) != 1 {
		t.Errorf("lab spec = %v, want only PAGE /lab", f.requirements(second.SpecID))
	}
	if _, ok := f.requirements(first.SpecID)["PAGE /orders"]; !ok {
		t.Errorf("the first environment's requirements were disturbed: %v", f.requirements(first.SpecID))
	}
	var title, envName string
	if err := f.h.Pool.QueryRow(ctx, `SELECT s.title, e.name FROM specs s JOIN environments e ON e.id = s.environment_id WHERE s.id = $1`, second.SpecID).Scan(&title, &envName); err != nil {
		t.Fatal(err)
	}
	if title != "Varredura automática · lab" || envName != "lab" {
		t.Errorf("title = %q, want it to say which environment it describes", title)
	}
	// regenerating the first still updates the first
	if _, again := f.generate(); again.SpecID != first.SpecID {
		t.Errorf("regenerating the first environment moved to another spec")
	}
}

func TestGenerate_TheRequirementTextDoesNotRepeatTheScreenTwice(t *testing.T) {
	f := setup(t)
	// what the runner writes when no model read the page: it already starts with "Tela <route> — ..."
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE nodes SET metadata = $2 WHERE id = $1`, f.w.Nodes["/orders"], `{"title":"Pedidos","summary":"Tela /orders — \"Pedidos\". títulos: Lista de pedidos; botões: Novo"}`); err != nil {
		t.Fatal(err)
	}
	_, res := f.generate()
	text := f.requirements(res.SpecID)["PAGE /orders"].Text
	if contains(text, "Tela /orders —") || contains(text, "títulos:") {
		t.Errorf("the mechanical summary only repeats the route: %q", text)
	}
	if !contains(text, "Título: Pedidos") {
		t.Errorf("the title belongs in the text: %q", text)
	}
}
