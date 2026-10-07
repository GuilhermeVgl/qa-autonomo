package testutil

import (
	"context"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/kpmg/agent-qa/control-plane/internal/bug"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
	"github.com/kpmg/agent-qa/control-plane/internal/step"
)

// World is a ready project: one environment, a graph with two covered nodes
// (/orders ← REQ-001 critical, /customers ← REQ-002 high) and one uncovered node (/reports).
type World struct {
	h         *Harness
	ProjectID uuid.UUID
	EnvID     uuid.UUID
	GraphID   uuid.UUID
	SpecID    uuid.UUID
	Nodes     map[string]uuid.UUID // label -> node id
	Reqs      map[string]uuid.UUID // key -> requirement id
	seq       int
}

func (h *Harness) SeedWorld() *World {
	h.T.Helper()
	ctx, org, pool := context.Background(), h.OrgID, h.Pool
	must := func(err error) {
		h.T.Helper()
		if err != nil {
			h.T.Fatal(err)
		}
	}
	w := &World{h: h, Nodes: map[string]uuid.UUID{}, Reqs: map[string]uuid.UUID{}}
	p, err := project.New(pool).CreateProject(ctx, project.CreateProjectParams{OrganizationID: org, Name: "P"})
	must(err)
	w.ProjectID = p.ID
	e, err := environment.New(pool).CreateEnvironment(ctx, environment.CreateEnvironmentParams{
		OrganizationID: org, ProjectID: p.ID, Name: "hml", BaseUrl: "https://a.com", AllowedHosts: []string{"a.com"}, DestructivePolicy: "block"})
	must(err)
	w.EnvID = e.ID
	g, err := graph.New(pool).CreateGraph(ctx, graph.CreateGraphParams{OrganizationID: org, ProjectID: p.ID, EnvironmentID: e.ID, Version: 1})
	must(err)
	w.GraphID = g.ID
	for _, l := range []string{"/orders", "/customers", "/reports"} {
		n, err := graph.New(pool).UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: org, GraphID: g.ID, Kind: "page", Fingerprint: "fp" + l, Label: l,
			AppRoles: []string{"admin"}, Metadata: []byte(`{"url":"https://a.com` + l + `"}`)})
		must(err)
		w.Nodes[l] = n.ID
	}
	sp, err := spec.New(pool).CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: org, ProjectID: p.ID, Version: 1, SourceType: "text", Title: "v1", ExtractedText: "t"})
	must(err)
	w.SpecID = sp.ID
	for key, link := range map[string][2]string{"REQ-001": {"critical", "/orders"}, "REQ-002": {"high", "/customers"}} {
		rq, err := spec.New(pool).CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: org, SpecID: sp.ID, Key: key, Text: key + " text", Criticality: link[0], Status: "new"})
		must(err)
		w.Reqs[key] = rq.ID
		_, err = pool.Exec(ctx, `INSERT INTO requirement_links (organization_id, requirement_id, node_id, confidence, source) VALUES ($1, $2, $3, 0.9, 'agent')`, org, rq.ID, w.Nodes[link[1]])
		must(err)
	}
	return w
}

// NewRun creates a finished run of the given type on the world's graph.
func (w *World) NewRun(typ string, started time.Time, duration time.Duration) uuid.UUID {
	w.h.T.Helper()
	ctx := context.Background()
	r, err := run.New(w.h.Pool).CreateRun(ctx, run.CreateRunParams{
		OrganizationID: w.h.OrgID, ProjectID: w.ProjectID, EnvironmentID: w.EnvID, GraphID: uuid.NullUUID{UUID: w.GraphID, Valid: true},
		Type: typ, Trigger: "manual", Budget: []byte(`{}`)})
	if err != nil {
		w.h.T.Fatal(err)
	}
	if _, err := w.h.Pool.Exec(ctx, `UPDATE runs SET status = 'succeeded', started_at = $2, finished_at = $3 WHERE id = $1`, r.ID, started, started.Add(duration)); err != nil {
		w.h.T.Fatal(err)
	}
	return r.ID
}

// Step records a finished step on the node (by label) and lets bugs react to it, like the runner API does.
func (w *World) Step(runID uuid.UUID, label, result, actual string) uuid.UUID {
	w.h.T.Helper()
	ctx := context.Background()
	w.seq++
	now := time.Now()
	res := result
	row, err := step.New(w.h.Pool).UpsertStep(ctx, step.UpsertStepParams{
		OrganizationID: w.h.OrgID, RunID: runID, ClientKey: label + "-" + strconv.Itoa(w.seq), NodeID: uuid.NullUUID{UUID: w.Nodes[label], Valid: true},
		Executor: strPtr("browser"), InputMasked: []byte(`{}`), Expected: "HTTP < 400", Actual: actual, Result: &res,
		StartedAt: pgtype.Timestamptz{Time: now, Valid: true}, FinishedAt: pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err != nil {
		w.h.T.Fatal(err)
	}
	if err := bug.Record(ctx, bug.New(w.h.Pool), bug.RecordInput{
		OrganizationID: w.h.OrgID, ProjectID: w.ProjectID, RunID: runID, StepID: row.ID, NodeID: w.Nodes[label],
		NodeFingerprint: "fp" + label, NodeLabel: label, Result: result, Actual: actual,
	}); err != nil {
		w.h.T.Fatal(err)
	}
	return row.ID
}

func strPtr(s string) *string { return &s }
