package pendency

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/knowledge"
	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
)

type pendencyView struct {
	ID            uuid.UUID  `json:"id"`
	RunID         *uuid.UUID `json:"run_id"`
	RequirementID uuid.UUID  `json:"requirement_id"`
	NodeID        *uuid.UUID `json:"node_id"`
	Question      string     `json:"question"`
	Answer        *string    `json:"answer"`
	Status        string     `json:"status"`
}

func toView(p Pendency) pendencyView {
	v := pendencyView{ID: p.ID, RequirementID: p.RequirementID, Question: p.Question, Status: p.Status}
	if p.RunID.Valid {
		v.RunID = &p.RunID.UUID
	}
	if p.NodeID.Valid {
		v.NodeID = &p.NodeID.UUID
	}
	if p.Answer != nil {
		v.Answer = p.Answer
	}
	return v
}

// Register mounts the cross-reference, pendency and coverage endpoints. completer may be nil (503).
func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool, completer Completer) {
	q := New(pool)
	envs, specs, graphs, know := environment.New(pool), spec.New(pool), graph.New(pool), knowledge.New(pool)
	write := func(h http.HandlerFunc) http.Handler { return mw(auth.RequireWriter(h)) }

	mux.Handle("POST /api/v1/environments/{id}/crossref", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		ctx, org := r.Context(), p.OrganizationID
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			SpecID *uuid.UUID `json:"spec_id"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		env, err := envs.GetEnvironment(ctx, environment.GetEnvironmentParams{OrganizationID: org, ID: eid})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		var sp spec.Spec
		if in.SpecID != nil {
			sp, err = specs.GetSpec(ctx, spec.GetSpecParams{OrganizationID: org, ID: *in.SpecID})
			if err == nil && sp.ProjectID != env.ProjectID {
				err = pgx.ErrNoRows
			}
		} else {
			sp, err = specs.GetLatestSpec(ctx, spec.GetLatestSpecParams{OrganizationID: org, ProjectID: env.ProjectID})
		}
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		g, err := graphs.GetLatestGraph(ctx, graph.GetLatestGraphParams{OrganizationID: org, EnvironmentID: env.ID})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		if completer == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "LLM is not configured")
			return
		}

		reqs, err := specs.ListRequirements(ctx, spec.ListRequirementsParams{OrganizationID: org, SpecID: sp.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		nodes, err := graphs.ListNodes(ctx, graph.ListNodesParams{OrganizationID: org, GraphID: g.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		entries, err := know.ListKnowledge(ctx, knowledge.ListKnowledgeParams{OrganizationID: org, ProjectID: env.ProjectID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		batches := makeBatches(reqs, nodes)
		if len(batches) > maxBatches {
			httpx.Error(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("the spec has more than %d requirements: split it into smaller specs", maxBatches*reqsPerCall))
			return
		}
		type parsedOutput struct {
			links []parsedLink
			pends []parsedPendency
		}
		var links []parsedLink
		var pends []parsedPendency
		linked := map[[2]uuid.UUID]bool{}
		for _, b := range batches {
			// a call only knows its own requirements and screens: it cannot link anything else
			reqIDs := make(map[string]uuid.UUID, len(b.reqs))
			for _, rq := range b.reqs {
				reqIDs[rq.Key] = rq.ID
			}
			msgs, refs := prompt(b.reqs, b.nodes, entries)
			res, err := llm.CompleteParsed(ctx, completer, org, "plan", msgs, func(out string) (parsedOutput, error) {
				l, p, err := parse(out, reqIDs, refs)
				return parsedOutput{l, p}, err
			})
			if errors.Is(err, llm.ErrInvalidOutput) {
				httpx.Error(w, http.StatusBadGateway, "cross-reference returned invalid output")
				return
			}
			if err != nil {
				httpx.Error(w, http.StatusBadGateway, "cross-reference failed")
				return
			}
			for _, l := range res.links {
				if k := [2]uuid.UUID{l.req, l.node}; !linked[k] {
					linked[k] = true
					links = append(links, l)
				}
			}
			pends = append(pends, res.pends...)
		}

		created, err := applyCrossref(ctx, pool, p, sp, g, reqs, links, pends)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]int{"links": len(links), "pendencies_created": created})
	}))

	mux.Handle("GET /api/v1/specs/{id}/pendencies", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		sid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListPendenciesBySpec(r.Context(), ListPendenciesBySpecParams{OrganizationID: p.OrganizationID, SpecID: sid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]pendencyView, 0, len(rows))
		for _, row := range rows {
			out = append(out, toView(row))
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("POST /api/v1/pendencies/{id}/answer", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		ctx, org := r.Context(), p.OrganizationID
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Answer string     `json:"answer"`
			NodeID *uuid.UUID `json:"node_id"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		in.Answer = strings.TrimSpace(in.Answer)
		if in.Answer == "" {
			httpx.Error(w, http.StatusBadRequest, "answer is required")
			return
		}
		pen, err := q.GetPendency(ctx, GetPendencyParams{OrganizationID: org, ID: id})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		if pen.Status != "open" {
			httpx.Error(w, http.StatusConflict, "pendency is not open")
			return
		}
		var nodeLabel string
		if in.NodeID != nil {
			n, err := graphs.GetNodeByID(ctx, graph.GetNodeByIDParams{OrganizationID: org, ID: *in.NodeID})
			if errors.Is(err, pgx.ErrNoRows) {
				httpx.Error(w, http.StatusBadRequest, "node_id does not exist")
				return
			}
			if err != nil {
				httpx.Error(w, http.StatusInternalServerError, "internal error")
				return
			}
			nodeLabel = n.Label
		}
		answered, err := applyAnswer(ctx, pool, p, pen, in.Answer, in.NodeID, nodeLabel)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusConflict, "pendency is not open")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, toView(answered))
	}))

	mux.Handle("POST /api/v1/pendencies/{id}/dismiss", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		row, err := q.DismissPendency(r.Context(), DismissPendencyParams{OrganizationID: p.OrganizationID, ID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			if _, getErr := q.GetPendency(r.Context(), GetPendencyParams{OrganizationID: p.OrganizationID, ID: id}); getErr == nil {
				httpx.Error(w, http.StatusConflict, "pendency is not open")
				return
			}
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, toView(row))
	}))

	mux.Handle("GET /api/v1/specs/{id}/coverage", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		ctx, org := r.Context(), p.OrganizationID
		sid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		gid, err := uuid.Parse(r.URL.Query().Get("graph_id"))
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "graph_id is required")
			return
		}
		sp, err := specs.GetSpec(ctx, spec.GetSpecParams{OrganizationID: org, ID: sid})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		g, err := graphs.GetGraph(ctx, graph.GetGraphParams{OrganizationID: org, ID: gid})
		if err == nil && g.ProjectID != sp.ProjectID {
			err = pgx.ErrNoRows
		}
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		cov, err := buildCoverage(ctx, q, specs, graphs, org, sp.ID, g.ID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, cov)
	})))
}

// applyCrossref stores the result atomically. Agent links for this spec×graph are replaced; human links stay.
// Pendencies are never duplicated: a requirement with an open pendency does not get another one.
func applyCrossref(ctx context.Context, pool *pgxpool.Pool, p auth.Principal, sp spec.Spec, g graph.Graph,
	reqs []spec.Requirement, links []parsedLink, pends []parsedPendency) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	q := New(tx)
	org := p.OrganizationID

	if err := q.DeleteAgentLinks(ctx, DeleteAgentLinksParams{OrganizationID: org, SpecID: sp.ID, GraphID: g.ID}); err != nil {
		return 0, err
	}
	for _, l := range links {
		if err := q.UpsertLink(ctx, UpsertLinkParams{OrganizationID: org, RequirementID: l.req, NodeID: l.node, Confidence: l.confidence, Source: "agent"}); err != nil {
			return 0, err
		}
	}
	if err := q.DismissOpenForLinkedRequirements(ctx, DismissOpenForLinkedRequirementsParams{OrganizationID: org, SpecID: sp.ID}); err != nil {
		return 0, err
	}

	created := 0
	raise := func(req uuid.UUID, node uuid.NullUUID, question string) error {
		open, err := q.HasOpenPendency(ctx, HasOpenPendencyParams{OrganizationID: org, RequirementID: req})
		if err != nil || open {
			return err
		}
		if _, err := q.CreatePendency(ctx, CreatePendencyParams{OrganizationID: org, RunID: g.SourceRunID, RequirementID: req, NodeID: node, Question: question}); err != nil {
			return err
		}
		created++
		return nil
	}
	for _, pd := range pends {
		if err := raise(pd.req, pd.node, pd.question); err != nil {
			return 0, err
		}
	}
	unlinked, err := q.ListUnlinkedRequirements(ctx, ListUnlinkedRequirementsParams{OrganizationID: org, SpecID: sp.ID, GraphID: g.ID})
	if err != nil {
		return 0, err
	}
	for _, rq := range unlinked {
		question := fmt.Sprintf("Não encontrei nenhuma tela que cubra %s (%s). Qual tela implementa este requisito, ou ele ainda não existe?", rq.Key, rq.Text)
		if err := raise(rq.ID, uuid.NullUUID{}, question); err != nil {
			return 0, err
		}
	}

	payload, _ := json.Marshal(map[string]any{"spec_id": sp.ID, "graph_id": g.ID, "links": len(links), "pendencies_created": created})
	if err := audit.New(tx).RecordAudit(ctx, audit.RecordAuditParams{
		OrganizationID: org, Actor: p.UserID.String(), Action: "crossref.run", Target: sp.ID.String(), Payload: payload,
	}); err != nil {
		return 0, err
	}
	_ = reqs
	return created, tx.Commit(ctx)
}

// applyAnswer answers the pendency; a node turns the answer into a human link, and the text into project knowledge.
func applyAnswer(ctx context.Context, pool *pgxpool.Pool, p auth.Principal, pen Pendency, answer string, nodeID *uuid.UUID, nodeLabel string) (Pendency, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Pendency{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	q := New(tx)
	org := p.OrganizationID

	answered, err := q.AnswerPendency(ctx, AnswerPendencyParams{OrganizationID: org, ID: pen.ID, Answer: &answer, AnsweredBy: uuid.NullUUID{UUID: p.UserID, Valid: true}})
	if err != nil {
		return Pendency{}, err
	}
	req, err := q.GetRequirementByID(ctx, GetRequirementByIDParams{OrganizationID: org, ID: pen.RequirementID})
	if err != nil {
		return Pendency{}, err
	}
	if nodeID != nil {
		if err := q.UpsertLink(ctx, UpsertLinkParams{OrganizationID: org, RequirementID: req.ID, NodeID: *nodeID, Confidence: 1, Source: "human"}); err != nil {
			return Pendency{}, err
		}
	}
	sp, err := spec.New(tx).GetSpec(ctx, spec.GetSpecParams{OrganizationID: org, ID: req.SpecID})
	if err != nil {
		return Pendency{}, err
	}
	content := fmt.Sprintf("%s (%s) — pergunta: %s — resposta: %s", req.Key, req.Text, pen.Question, answer)
	if nodeLabel != "" {
		content += fmt.Sprintf(" — tela: %s", nodeLabel)
	}
	if _, err := knowledge.New(tx).CreateKnowledge(ctx, knowledge.CreateKnowledgeParams{
		OrganizationID: org, ProjectID: sp.ProjectID, Content: content, Origin: "pendency", OriginID: uuid.NullUUID{UUID: pen.ID, Valid: true},
	}); err != nil {
		return Pendency{}, err
	}
	payload, _ := json.Marshal(map[string]any{"requirement": req.Key, "linked": nodeID != nil})
	if err := audit.New(tx).RecordAudit(ctx, audit.RecordAuditParams{
		OrganizationID: org, Actor: p.UserID.String(), Action: "pendency.answer", Target: pen.ID.String(), Payload: payload,
	}); err != nil {
		return Pendency{}, err
	}
	return answered, tx.Commit(ctx)
}

type requirementCoverage struct {
	Key         string      `json:"key"`
	Text        string      `json:"text"`
	Criticality string      `json:"criticality"`
	Status      string      `json:"status"` // covered | pending | unmatched
	NodeIDs     []uuid.UUID `json:"node_ids"`
}

type nodeCoverage struct {
	NodeID          uuid.UUID `json:"node_id"`
	Label           string    `json:"label"`
	Status          string    `json:"status"` // covered | no_spec
	RequirementKeys []string  `json:"requirement_keys"`
}

type coverageView struct {
	Requirements []requirementCoverage `json:"requirements"`
	Nodes        []nodeCoverage        `json:"nodes"`
}

// buildCoverage: 🟢 covered (linked) · 🟠 pending (open pendency, no link) · unmatched (no link, nothing open); nodes ⚪ no_spec.
func buildCoverage(ctx context.Context, q *Queries, specs *spec.Queries, graphs *graph.Queries, org, specID, graphID uuid.UUID) (coverageView, error) {
	reqs, err := specs.ListRequirements(ctx, spec.ListRequirementsParams{OrganizationID: org, SpecID: specID})
	if err != nil {
		return coverageView{}, err
	}
	nodes, err := graphs.ListNodes(ctx, graph.ListNodesParams{OrganizationID: org, GraphID: graphID})
	if err != nil {
		return coverageView{}, err
	}
	links, err := q.ListLinksForSpecAndGraph(ctx, ListLinksForSpecAndGraphParams{OrganizationID: org, SpecID: specID, GraphID: graphID})
	if err != nil {
		return coverageView{}, err
	}
	pends, err := q.ListPendenciesBySpec(ctx, ListPendenciesBySpecParams{OrganizationID: org, SpecID: specID})
	if err != nil {
		return coverageView{}, err
	}

	keyOf := make(map[uuid.UUID]string, len(reqs))
	for _, r := range reqs {
		keyOf[r.ID] = r.Key
	}
	nodesOfReq := map[uuid.UUID][]uuid.UUID{}
	keysOfNode := map[uuid.UUID][]string{}
	for _, l := range links {
		nodesOfReq[l.RequirementID] = append(nodesOfReq[l.RequirementID], l.NodeID)
		keysOfNode[l.NodeID] = append(keysOfNode[l.NodeID], keyOf[l.RequirementID])
	}
	openFor := map[uuid.UUID]bool{}
	for _, p := range pends {
		if p.Status == "open" {
			openFor[p.RequirementID] = true
		}
	}

	out := coverageView{Requirements: make([]requirementCoverage, 0, len(reqs)), Nodes: make([]nodeCoverage, 0, len(nodes))}
	for _, r := range reqs {
		rc := requirementCoverage{Key: r.Key, Text: r.Text, Criticality: r.Criticality, NodeIDs: nodesOfReq[r.ID]}
		switch {
		case len(rc.NodeIDs) > 0:
			rc.Status = "covered"
		case openFor[r.ID]:
			rc.Status = "pending"
		default:
			rc.Status = "unmatched"
		}
		if rc.NodeIDs == nil {
			rc.NodeIDs = []uuid.UUID{}
		}
		out.Requirements = append(out.Requirements, rc)
	}
	for _, n := range nodes {
		nc := nodeCoverage{NodeID: n.ID, Label: n.Label, Status: "no_spec", RequirementKeys: keysOfNode[n.ID]}
		if len(nc.RequirementKeys) > 0 {
			nc.Status = "covered"
		} else {
			nc.RequirementKeys = []string{}
		}
		out.Nodes = append(out.Nodes, nc)
	}
	return out, nil
}

func notFoundOr500(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not found")
		return
	}
	httpx.Error(w, http.StatusInternalServerError, "internal error")
}
