package pendency

import (
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
)

func reqs(n int, text func(i int) string) []spec.Requirement {
	out := make([]spec.Requirement, n)
	for i := range out {
		out[i] = spec.Requirement{ID: uuid.New(), Key: fmt.Sprintf("REQ-%03d", i+1), Text: text(i), Criticality: "normal"}
	}
	return out
}

func nodesOf(labels ...string) []graph.Node {
	out := make([]graph.Node, len(labels))
	for i, l := range labels {
		out[i] = graph.Node{ID: uuid.New(), Kind: "page", Label: l, AppRoles: []string{"admin"}, Metadata: []byte(`{}`)}
	}
	return out
}

func TestMakeBatches_SplitsRequirementsAndKeepsEveryOneExactlyOnce(t *testing.T) {
	rs := reqs(60, func(i int) string { return fmt.Sprintf("Requisito número %d", i) })
	bs := makeBatches(rs, nodesOf("/orders", "/customers"))
	if len(bs) != 3 { // 25 + 25 + 10
		t.Fatalf("batches = %d, want 3", len(bs))
	}
	seen := map[string]int{}
	for _, b := range bs {
		if len(b.reqs) > reqsPerCall {
			t.Errorf("a batch has %d requirements, over %d", len(b.reqs), reqsPerCall)
		}
		for _, r := range b.reqs {
			seen[r.Key]++
		}
	}
	for _, r := range rs {
		if seen[r.Key] != 1 {
			t.Errorf("%s appears %d times", r.Key, seen[r.Key])
		}
	}
}

func TestMakeBatches_SmallMapsGoWholeToEveryBatch(t *testing.T) {
	bs := makeBatches(reqs(30, func(i int) string { return "x" }), nodesOf("/a", "/b", "/c"))
	for _, b := range bs {
		if len(b.nodes) != 3 {
			t.Errorf("a batch got %d of 3 nodes: with a small map nothing is left out", len(b.nodes))
		}
	}
}

func TestMakeBatches_BigMapsGetTheNodesEachBatchIsAbout(t *testing.T) {
	labels := make([]string, 0, 400)
	for i := 0; i < 400; i++ {
		labels = append(labels, fmt.Sprintf("/modulo%d/listagem", i))
	}
	labels[350] = "/faturas/emitidas"
	labels[37] = "/clientes/cadastro"
	rs := reqs(2, func(i int) string {
		if i == 0 {
			return "A advogada emite faturas e vê as faturas emitidas"
		}
		return "A advogada abre o cadastro de clientes"
	})
	nodes := nodesOf(labels...)
	bs := makeBatches(rs, nodes)
	if len(bs) != 1 {
		t.Fatalf("batches = %d, want the 2 requirements in one", len(bs))
	}
	got := map[string]bool{}
	for _, n := range bs[0].nodes {
		got[n.Label] = true
	}
	if len(bs[0].nodes) > nodesPerCall {
		t.Errorf("the batch has %d nodes, over %d", len(bs[0].nodes), nodesPerCall)
	}
	if !got["/faturas/emitidas"] || !got["/clientes/cadastro"] {
		t.Errorf("the nodes the requirements are about must be in the prompt, even deep in a big map (old limit: the first 300)")
	}
}

func TestMakeBatches_RelevanceUsesWhatTheAgentLearnedAboutTheScreenToo(t *testing.T) {
	labels := make([]string, 300)
	for i := range labels {
		labels[i] = fmt.Sprintf("/tela%d", i)
	}
	nodes := nodesOf(labels...)
	nodes[200].Metadata = []byte(`{"summary":"Emissão de notas fiscais do mês","forms":[{"label":"Nova nota","method":"POST","action":"/tela200"}]}`)
	bs := makeBatches(reqs(1, func(int) string { return "O sistema emite notas fiscais" }), nodes)
	found := false
	for _, n := range bs[0].nodes {
		found = found || n.Label == "/tela200"
	}
	if !found {
		t.Error("a screen described as emitting invoices must be offered for a requirement about issuing invoices")
	}
}

func TestMakeBatches_StaysUnderTheNodeLimitWhateverTheRequirementsAsk(t *testing.T) {
	labels := make([]string, 500)
	for i := range labels {
		labels[i] = fmt.Sprintf("/area%d/pedidos", i) // every node shares the word "pedidos"
	}
	rs := reqs(25, func(i int) string { return fmt.Sprintf("Pedidos da área %d", i) })
	for _, b := range makeBatches(rs, nodesOf(labels...)) {
		if len(b.nodes) > nodesPerCall {
			t.Fatalf("a batch has %d nodes", len(b.nodes))
		}
		if len(b.nodes) == 0 {
			t.Fatal("a batch with no nodes can link nothing")
		}
	}
}

func TestPrompt_NumbersTheNodesOfABatchFromOne(t *testing.T) {
	ns := nodesOf("/a", "/b")
	_, refs := prompt(reqs(1, func(int) string { return "x" }), ns, nil)
	if refs["n1"] != ns[0].ID || refs["n2"] != ns[1].ID || len(refs) != 2 {
		t.Errorf("refs = %v", refs)
	}
	msgs, _ := prompt(reqs(1, func(int) string { return "x" }), ns, nil)
	if !strings.Contains(msgs[1].Content, "n1: page /a") {
		t.Errorf("prompt = %s", msgs[1].Content)
	}
}
