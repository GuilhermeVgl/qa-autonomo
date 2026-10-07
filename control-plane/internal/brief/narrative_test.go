package brief

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/report"
)

func factsWithResults() Facts {
	w := shop()
	w.in.Regression = regression(w, 8, 2, report.RequirementOutcome{Key: "REQ-001", Text: "A advogada vê a lista de pedidos", Criticality: "critical", Outcome: "fail", ByUser: map[string]string{"operador": "fail", "admin": "pass"}})
	w.in.Bugs = []bugRow{{Title: "/orders: HTTP 500", Severity: "critical", Status: "new", Users: []string{"operador"}}}
	return analyze(w.in)
}

func TestTemplate_AlwaysHasTheSameSectionsInTheSameOrder(t *testing.T) {
	want := []string{"scope", "coverage", "flows", "users", "results", "risks", "security", "next"}
	for name, f := range map[string]Facts{"full": factsWithResults(), "empty": analyze(input{Project: "P", Env: envInfo{Name: "e"}})} {
		n := Template(f)
		var got []string
		for _, s := range n.Sections {
			got = append(got, s.ID)
			if strings.TrimSpace(s.Body) == "" || s.Title == "" {
				t.Errorf("%s: section %q has no body or title", name, s.ID)
			}
		}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%s: sections = %v, want %v", name, got, want)
		}
		if n.Source != "template" || strings.TrimSpace(n.ExecutiveSummary) == "" || len(n.Recommendations) == 0 {
			t.Errorf("%s: narrative = %+v", name, n)
		}
	}
}

func TestTemplate_SaysWhatTheNumbersAre(t *testing.T) {
	n := Template(factsWithResults())
	all := n.ExecutiveSummary + "\n"
	for _, s := range n.Sections {
		all += s.Body + "\n"
	}
	for _, want := range []string{"hml", "Loja", "4 telas", "75%", "8", "REQ-002", "operador", "/orders: HTTP 500", "/admin"} {
		if !strings.Contains(all, want) {
			t.Errorf("the report must mention %q; got:\n%s", want, all)
		}
	}
	if !strings.Contains(n.Recommendations[0], "REQ-001") && !strings.Contains(strings.ToLower(n.Recommendations[0]), "crític") {
		t.Errorf("the first recommendation addresses the most serious issue: %v", n.Recommendations)
	}
}

func TestTemplate_AnEmptyEnvironmentSaysToExploreFirst(t *testing.T) {
	n := Template(analyze(input{Project: "P", Env: envInfo{Name: "e"}}))
	if !strings.Contains(strings.ToLower(n.ExecutiveSummary), "explor") {
		t.Errorf("summary = %q", n.ExecutiveSummary)
	}
	if !strings.Contains(strings.ToLower(n.Recommendations[0]), "explor") {
		t.Errorf("recommendations = %v", n.Recommendations)
	}
}

type fixedCompleter struct {
	replies []string
	calls   int
	prompts []string
}

func (c *fixedCompleter) Complete(_ context.Context, _ uuid.UUID, _ string, msgs []llm.Message, _ bool) (string, error) {
	c.prompts = append(c.prompts, msgs[len(msgs)-1].Content)
	r := c.replies[min(c.calls, len(c.replies)-1)]
	c.calls++
	return r, nil
}

const validReply = `{"executive_summary":"No ambiente hml do projeto Loja foram mapeadas 4 telas. A cobertura de requisitos é de 75%.",
"sections":[
 {"id":"scope","body":"O ambiente hml foi explorado com 2 usuários."},
 {"id":"coverage","body":"REQ-002 não está ligado a nenhuma tela."},
 {"id":"flows","body":"A tela /orders tem uma jornada com janela e chamada de API."},
 {"id":"users","body":"As telas /admin e /help não são alcançadas pelo operador."},
 {"id":"results","body":"Na última regressão 8 passaram e 2 falharam."},
 {"id":"risks","body":"Há 1 bug crítico aberto em /orders."},
 {"id":"security","body":"Nenhuma falha de segurança está aberta."},
 {"id":"next","body":"Ligar REQ-002 a uma tela e corrigir o bug crítico."}],
"recommendations":["Corrigir o bug crítico de /orders.","Ligar o REQ-002 a uma tela."]}`

func TestAINarrative_KeepsTheFixedStructureAndOurTitles(t *testing.T) {
	c := &fixedCompleter{replies: []string{validReply}}
	n, err := AINarrative(context.Background(), c, uuid.New(), factsWithResults())
	if err != nil {
		t.Fatal(err)
	}
	if n.Source != "ai" || len(n.Sections) != 8 || n.Sections[0].ID != "scope" || n.Sections[0].Title != "Escopo e método" {
		t.Errorf("narrative = %+v: the model writes the text, never the structure", n)
	}
	if !strings.Contains(c.prompts[0], "REQ-002") || !strings.Contains(c.prompts[0], `"percent_requirements": 75`) {
		t.Errorf("the model must be given the facts:\n%.400s", c.prompts[0])
	}
}

func TestAINarrative_RejectsWhatBreaksTheStandardOrInventsFacts(t *testing.T) {
	bad := map[string]string{
		"a section missing":  strings.Replace(validReply, `{"id":"next","body":"Ligar REQ-002 a uma tela e corrigir o bug crítico."}`, `{"id":"scope","body":"duplicada"}`, 1),
		"an unknown section": strings.Replace(validReply, `"id":"next"`, `"id":"extra"`, 1),
		"an invented number": strings.Replace(validReply, "8 passaram e 2 falharam", "93 passaram e 2 falharam", 1),
		"empty body":         strings.Replace(validReply, "O ambiente hml foi explorado com 2 usuários.", " ", 1),
		"no recommendations": strings.Replace(validReply, `"recommendations":["Corrigir o bug crítico de /orders.","Ligar o REQ-002 a uma tela."]`, `"recommendations":[]`, 1),
		"not json":           "Aqui está o relatório!",
		"unknown field":      strings.Replace(validReply, `"recommendations"`, `"extra":1,"recommendations"`, 1),
	}
	for name, reply := range bad {
		c := &fixedCompleter{replies: []string{reply, reply}}
		if _, err := AINarrative(context.Background(), c, uuid.New(), factsWithResults()); err == nil {
			t.Errorf("%s: the narrative must be rejected", name)
		}
	}
}

func TestAINarrative_AsksOnceMoreWhenTheFirstReplyBreaksTheRules(t *testing.T) {
	c := &fixedCompleter{replies: []string{strings.Replace(validReply, "8 passaram", "93 passaram", 1), validReply}}
	if _, err := AINarrative(context.Background(), c, uuid.New(), factsWithResults()); err != nil || c.calls != 2 {
		t.Fatalf("err=%v calls=%d, want a second try that works", err, c.calls)
	}
	if !strings.Contains(c.prompts[1], "93") {
		t.Errorf("the second try must tell the model what was wrong:\n%.300s", c.prompts[1])
	}
}

func TestAINarrative_DropsATitleTheModelRepeatedAtTheStartOfASection(t *testing.T) {
	reply := strings.Replace(validReply, `"body":"O ambiente hml foi explorado com 2 usuários."`, `"body":"Escopo e método\n\nO ambiente hml foi explorado com 2 usuários."`, 1)
	reply = strings.Replace(reply, `"body":"REQ-002 não está ligado a nenhuma tela."`, `"body":"## Cobertura: especificações e telas\nREQ-002 não está ligado a nenhuma tela."`, 1)
	n, err := AINarrative(context.Background(), &fixedCompleter{replies: []string{reply}}, uuid.New(), factsWithResults())
	if err != nil {
		t.Fatal(err)
	}
	if got := n.Sections[0].Body; got != "O ambiente hml foi explorado com 2 usuários." {
		t.Errorf("scope body = %q: the title is already the heading", got)
	}
	if got := n.Sections[1].Body; got != "REQ-002 não está ligado a nenhuma tela." {
		t.Errorf("coverage body = %q", got)
	}
}

func TestTemplate_NoJourneysIsSaidInPlainWords(t *testing.T) {
	w := shop()
	w.in.Edges = nil
	flows := ""
	for _, s := range Template(analyze(w.in)).Sections {
		if s.ID == "flows" {
			flows = s.Body
		}
	}
	if strings.Contains(flows, "0 telas") || !strings.Contains(strings.ToLower(flows), "nenhuma tela") {
		t.Errorf("flows = %q, want to say that no screen with actions was found", flows)
	}
}

func TestReqLabel_GeneratedKeysSpeakForThemselves(t *testing.T) {
	if got := reqLabel("PAGE /orders", "A tela /orders responde sem erro (HTTP < 400) e mantém a estrutura mapeada."); got != "PAGE /orders" {
		t.Errorf("generated requirement = %q: the key already says everything", got)
	}
	if got := reqLabel("FORM POST /clients", "O formulário..."); got != "FORM POST /clients" {
		t.Errorf("form = %q", got)
	}
	if got := reqLabel("REQ-001", "A advogada vê a lista"); got != "REQ-001: A advogada vê a lista" {
		t.Errorf("written requirement = %q", got)
	}
}

func TestAnalyze_EveryListIsAListNeverNull(t *testing.T) {
	f := analyze(shop().in)
	for name, v := range map[string]bool{
		"screens_without_requirement": f.Coverage.ScreensWithoutRequirement != nil,
		"unlinked":                    f.Coverage.Unlinked != nil,
		"journey routes":              f.Journeys.Routes != nil,
		"journey without requirement": f.Journeys.WithoutRequirement != nil,
		"bug list":                    f.Bugs.List != nil,
		"access":                      f.Access != nil,
	} {
		if !v {
			t.Errorf("%s is null in the JSON: the screens read lists, never null", name)
		}
	}
	clean := analyze(input{Now: time.Now(), Project: "P", Env: envInfo{Name: "e"}})
	if clean.Coverage.ScreensWithoutRequirement == nil || clean.Bugs.List == nil || clean.Journeys.Routes == nil {
		t.Error("an empty environment must also have empty lists")
	}
}

func TestAnalyze_ListsAreCappedButTheCountsAreReal(t *testing.T) {
	w := shop()
	for i := 0; i < 40; i++ {
		node(w, "x"+string(rune('a'+i%26))+string(rune('A'+i/26)), "page", "/extra"+string(rune('a'+i%26))+string(rune('A'+i/26)), "admin")
		req(w, "Regras", "text", "REQ-9"+string(rune('a'+i%26))+string(rune('A'+i/26)), "Requisito solto número extra "+string(rune('a'+i)), "normal")
	}
	f := analyze(w.in)
	if len(f.Coverage.ScreensWithoutRequirement) != maxListed || f.Coverage.ScreensWithoutRequirementTotal != 42 {
		t.Errorf("screens without requirement: %d listed of %d, want %d listed of 42", len(f.Coverage.ScreensWithoutRequirement), f.Coverage.ScreensWithoutRequirementTotal, maxListed)
	}
	if len(f.Coverage.Unlinked) != maxListed || f.Coverage.UnlinkedTotal != 41 {
		t.Errorf("unlinked: %d listed of %d, want %d listed of 41", len(f.Coverage.Unlinked), f.Coverage.UnlinkedTotal, maxListed)
	}
	for _, i := range f.Issues {
		if i.Code == "requirements_unlinked" && !strings.HasPrefix(i.Message, "41 requisitos") {
			t.Errorf("the issue must count all of them, not the listed ones: %q", i.Message)
		}
		if i.Code == "screens_without_requirement" && !strings.HasPrefix(i.Message, "42 telas") {
			t.Errorf("the issue must count all of them: %q", i.Message)
		}
	}
}
