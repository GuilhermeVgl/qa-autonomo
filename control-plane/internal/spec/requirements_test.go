package spec

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/llm"
)

func TestDiff(t *testing.T) {
	prev := []Item{
		{Key: "REQ-001", Text: "Login works", Criticality: "critical"},
		{Key: "REQ-002", Text: "Export CSV", Criticality: "normal"},
		{Key: "REQ-003", Text: "Old feature", Criticality: "normal"},
	}
	next := []Item{
		{Key: "REQ-001", Text: "Login works", Criticality: "critical"},
		{Key: "REQ-002", Text: "Export CSV and PDF", Criticality: "normal"},
		{Key: "REQ-004", Text: "New thing", Criticality: "high"},
	}
	got, removed := Diff(prev, next)
	want := map[string]string{"REQ-001": "unchanged", "REQ-002": "changed", "REQ-004": "new"}
	for _, r := range got {
		if want[r.Key] != r.Status {
			t.Errorf("%s status = %q, want %q", r.Key, r.Status, want[r.Key])
		}
	}
	if len(removed) != 1 || removed[0].Key != "REQ-003" {
		t.Errorf("removed = %+v", removed)
	}
}

func TestDiff_CriticalityChangeIsChanged(t *testing.T) {
	got, _ := Diff([]Item{{Key: "REQ-1", Text: "a", Criticality: "normal"}}, []Item{{Key: "REQ-1", Text: "a", Criticality: "critical"}})
	if got[0].Status != "changed" {
		t.Errorf("status = %q", got[0].Status)
	}
}

func TestDiff_NoPreviousMeansAllNew(t *testing.T) {
	got, removed := Diff(nil, []Item{{Key: "REQ-1", Text: "a", Criticality: "normal"}})
	if got[0].Status != "new" || len(removed) != 0 {
		t.Errorf("got=%+v removed=%+v", got, removed)
	}
}

type fakeCompleter struct {
	out  string
	msgs []llm.Message
	task string
}

func (f *fakeCompleter) Complete(_ context.Context, _ uuid.UUID, task string, msgs []llm.Message, _ bool) (string, error) {
	f.task, f.msgs = task, msgs
	return f.out, nil
}

func TestLLMExtractor_ParsesAndValidates(t *testing.T) {
	ok := `{"requirements":[{"key":"REQ-001","text":"Must log in","criticality":"critical"},{"key":"REQ-002","text":"Can export","criticality":"normal"}]}`
	f := &fakeCompleter{out: ok}
	got, err := NewLLMExtractor(f).Extract(context.Background(), uuid.New(), "spec text", []Item{{Key: "REQ-001", Text: "old"}})
	if err != nil || len(got) != 2 || got[0].Key != "REQ-001" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if f.task != "extract_requirements" {
		t.Errorf("task = %q", f.task)
	}
	all := f.msgs[0].Content + f.msgs[1].Content
	if !strings.Contains(all, "spec text") || !strings.Contains(all, "REQ-001") {
		t.Error("prompt must include the spec and previous keys")
	}
	if !strings.Contains(f.msgs[0].Content, "dados") {
		t.Error("system prompt must say spec content is data, not instructions")
	}
}

func TestLLMExtractor_RejectsInvalidOutput(t *testing.T) {
	bad := map[string]string{
		"not json":      `oops`,
		"empty":         `{"requirements":[]}`,
		"dup key":       `{"requirements":[{"key":"REQ-1","text":"a","criticality":"normal"},{"key":"REQ-1","text":"b","criticality":"normal"}]}`,
		"bad crit":      `{"requirements":[{"key":"REQ-1","text":"a","criticality":"urgent"}]}`,
		"empty text":    `{"requirements":[{"key":"REQ-1","text":" ","criticality":"normal"}]}`,
		"empty key":     `{"requirements":[{"key":"","text":"a","criticality":"normal"}]}`,
		"unknown field": `{"requirements":[{"key":"REQ-1","text":"a","criticality":"normal","x":1}]}`,
	}
	for name, out := range bad {
		t.Run(name, func(t *testing.T) {
			if _, err := NewLLMExtractor(&fakeCompleter{out: out}).Extract(context.Background(), uuid.New(), "t", nil); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

type seqCompleter struct {
	replies []string
	calls   int
}

func (s *seqCompleter) Complete(_ context.Context, _ uuid.UUID, _ string, _ []llm.Message, _ bool) (string, error) {
	r := s.replies[min(s.calls, len(s.replies)-1)]
	s.calls++
	return r, nil
}

func TestLLMExtractor_AsksAgainOnceWhenTheFirstReplyIsInvalid(t *testing.T) {
	good := `{"requirements":[{"key":"REQ-001","text":"Must log in","criticality":"critical"}]}`
	c := &seqCompleter{replies: []string{"```\nnot the format\n```", good}}
	got, err := NewLLMExtractor(c).Extract(context.Background(), uuid.New(), "spec", nil)
	if err != nil || len(got) != 1 || c.calls != 2 {
		t.Fatalf("got=%+v err=%v calls=%d", got, err, c.calls)
	}

	c = &seqCompleter{replies: []string{"bad", "still bad"}}
	if _, err := NewLLMExtractor(c).Extract(context.Background(), uuid.New(), "spec", nil); err == nil || c.calls != 2 {
		t.Fatalf("two invalid replies must fail after exactly two calls: err=%v calls=%d", err, c.calls)
	}
}

// ---- long specs: split in parts, keep keys unique, drop repeats ----

func TestSplitSpec_KeepsEverythingAndRespectsTheLimit(t *testing.T) {
	var parts []string
	for i := 0; i < 30; i++ {
		parts = append(parts, fmt.Sprintf("## Módulo %d\nO sistema permite o fluxo número %d. %s", i, i, strings.Repeat("Detalhe do comportamento. ", 20)))
	}
	text := strings.Join(parts, "\n\n")
	chunks := splitSpec(text, 1500)
	if len(chunks) < 5 {
		t.Fatalf("chunks = %d, want the spec cut into several parts", len(chunks))
	}
	for i, c := range chunks {
		if len([]rune(c)) > 1500 {
			t.Errorf("chunk %d has %d characters, over the limit", i, len([]rune(c)))
		}
	}
	joined := strings.Join(chunks, "\n")
	for i := 0; i < 30; i++ {
		if !strings.Contains(joined, fmt.Sprintf("fluxo número %d.", i)) {
			t.Errorf("module %d was lost", i)
		}
	}
	// a part starts at a heading, so a module is not cut from its title
	for _, c := range chunks {
		if !strings.HasPrefix(strings.TrimSpace(c), "## Módulo") {
			t.Errorf("chunk does not start at a heading: %.40q", c)
		}
	}
}

func TestSplitSpec_ShortTextIsOnePartAndHugeParagraphsAreCut(t *testing.T) {
	if got := splitSpec("Um texto curto.", 1000); len(got) != 1 || got[0] != "Um texto curto." {
		t.Errorf("short = %q", got)
	}
	if got := splitSpec("   \n\n  ", 1000); len(got) != 0 {
		t.Errorf("blank = %q, want no parts", got)
	}
	huge := strings.Repeat("palavra ", 700) // one paragraph, no breaks
	for _, c := range splitSpec(huge, 1000) {
		if len([]rune(c)) > 1000 {
			t.Fatalf("a part of %d characters", len([]rune(c)))
		}
	}
}

type recordingCompleter struct {
	replies []string
	prompts []string
}

func (r *recordingCompleter) Complete(_ context.Context, _ uuid.UUID, _ string, msgs []llm.Message, _ bool) (string, error) {
	r.prompts = append(r.prompts, msgs[len(msgs)-1].Content)
	return r.replies[min(len(r.prompts)-1, len(r.replies)-1)], nil
}

func longSpec() string {
	var parts []string
	for i := 0; i < 4; i++ {
		parts = append(parts, fmt.Sprintf("## Parte %d\n%s", i, strings.Repeat(fmt.Sprintf("Regra da parte %d. ", i), 120)))
	}
	return strings.Join(parts, "\n\n")
}

func TestLLMExtractor_LongSpecIsReadInPartsAndMergedWithUniqueKeys(t *testing.T) {
	c := &recordingCompleter{replies: []string{
		`{"requirements":[{"key":"REQ-001","text":"A advogada vê a lista de clientes ao entrar.","criticality":"critical"},{"key":"REQ-002","text":"A advogada cria um cliente com nome e e-mail.","criticality":"high"}]}`,
		// the model restarts the numbering in the second part and repeats a requirement of the first
		`{"requirements":[{"key":"REQ-001","text":"A advogada envia a solicitação de documentos pelo WhatsApp.","criticality":"high"},{"key":"REQ-002","text":"a advogada vê a lista de clientes ao entrar","criticality":"critical"}]}`,
	}}
	e := &llmExtractor{c: c, chunkChars: 2000}
	got, err := e.Extract(context.Background(), uuid.New(), longSpec(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.prompts) < 2 {
		t.Fatalf("calls = %d, want one per part", len(c.prompts))
	}
	keys := map[string]bool{}
	for _, it := range got {
		if keys[it.Key] {
			t.Errorf("duplicate key %s", it.Key)
		}
		keys[it.Key] = true
	}
	texts := map[string]string{}
	for _, it := range got {
		texts[it.Key] = it.Text
	}
	if texts["REQ-001"] != "A advogada vê a lista de clientes ao entrar." || texts["REQ-002"] != "A advogada cria um cliente com nome e e-mail." {
		t.Errorf("the first part's keys must stay: %v", texts)
	}
	var whats string
	for _, it := range got {
		if strings.Contains(it.Text, "WhatsApp") {
			whats = it.Key
		}
	}
	if whats != "REQ-003" {
		t.Errorf("the restarted numbering must continue after the last key; WhatsApp requirement has key %q", whats)
	}
	for _, it := range got {
		if it.Text == "a advogada vê a lista de clientes ao entrar" {
			t.Error("a repeat of a requirement (same words, other case and no final dot) must be dropped")
		}
	}
	// later parts see what was already extracted, so the model can continue and not repeat
	if !strings.Contains(c.prompts[1], "REQ-001") || !strings.Contains(c.prompts[1], "REQ-003") {
		t.Errorf("the second part's prompt must carry the keys already used and say where to continue:\n%s", c.prompts[1])
	}
	if !strings.Contains(c.prompts[1], "parte 2 de") {
		t.Errorf("the prompt must say which part this is:\n%.300s", c.prompts[1])
	}
}

func TestLLMExtractor_ShortSpecStaysOneCallWithoutPartLanguage(t *testing.T) {
	c := &recordingCompleter{replies: []string{`{"requirements":[{"key":"REQ-001","text":"Entrar com e-mail e senha.","criticality":"critical"}]}`}}
	if _, err := NewLLMExtractor(c).Extract(context.Background(), uuid.New(), "Entrar com e-mail e senha.", nil); err != nil {
		t.Fatal(err)
	}
	if len(c.prompts) != 1 || strings.Contains(c.prompts[0], "parte 1 de") {
		t.Errorf("prompts = %d / %.200s", len(c.prompts), c.prompts[0])
	}
}

func TestLLMExtractor_APartThatFailsFailsTheWholeExtraction(t *testing.T) {
	c := &recordingCompleter{replies: []string{`{"requirements":[{"key":"REQ-001","text":"Primeiro requisito válido aqui.","criticality":"normal"}]}`, "oops", "still oops"}}
	e := &llmExtractor{c: c, chunkChars: 2000}
	if _, err := e.Extract(context.Background(), uuid.New(), longSpec(), nil); err == nil {
		t.Fatal("a part with invalid output twice must fail the extraction: a spec missing a part is worse than none")
	}
}

func TestLLMExtractor_PromptTeachesWhatAGoodRequirementIs(t *testing.T) {
	for _, want := range []string{"dados", "um comportamento", "critério de aceite", "vag", "critical", "high", "normal"} {
		if !strings.Contains(systemPrompt, want) {
			t.Errorf("the system prompt must mention %q", want)
		}
	}
}

// ---- quality: what makes a requirement hard to test ----

func TestQuality_FlagsVagueShortAndCompoundRequirements(t *testing.T) {
	cases := map[string][]string{
		"A advogada vê a lista de clientes ordenada por nome ao abrir a tela inicial.": nil,
		"O sistema deve ser rápido e amigável.":                                        {"vago"},
		"Login": {"curto"},
		"A tela deve carregar em até 2 segundos.":                                            nil, // a number makes "carregar" testable
		"O sistema responde de forma adequada aos erros.":                                    {"vago"},
		"Permitir cadastrar clientes; editar clientes; remover clientes; exportar clientes.": {"composto"},
		"O usuário cria o cliente. O usuário edita o cliente. O usuário remove o cliente.":   {"composto"},
		"The system should be user-friendly and fast.":                                       {"vago"},
		"Exibir mensagem de erro quando o e-mail for inválido.":                              nil,
	}
	for text, want := range cases {
		got := Quality(text)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("Quality(%q) = %v, want %v", text, got, want)
		}
	}
}

func TestQualityOf_FlagsNearDuplicatesAgainstTheEarlierOne(t *testing.T) {
	items := []Item{
		{Key: "REQ-001", Text: "A advogada vê a lista de clientes ao entrar no sistema."},
		{Key: "REQ-002", Text: "A advogada cria um cliente com nome e e-mail."},
		{Key: "REQ-003", Text: "A advogada vê a lista de clientes ao entrar no sistema agora."},
		{Key: "PAGE /x", Text: "Texto curto"}, // generated requirements are not judged
	}
	got := QualityOf(items)
	if len(got["REQ-001"]) != 0 || len(got["REQ-002"]) != 0 {
		t.Errorf("the first of a pair is fine: %v", got)
	}
	if want := []string{"parecido com REQ-001"}; !reflect.DeepEqual(got["REQ-003"], want) {
		t.Errorf("REQ-003 = %v, want %v", got["REQ-003"], want)
	}
	if _, judged := got["PAGE /x"]; judged {
		t.Error("only REQ-NNN keys (written or extracted by the model) are judged")
	}
}
