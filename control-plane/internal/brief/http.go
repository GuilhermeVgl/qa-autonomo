package brief

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/bug"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/report"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
)

// Capabilities says what this installation has, for the readiness checks.
type Capabilities struct {
	LLM     bool
	Storage bool
}

type response struct {
	Facts     Facts     `json:"facts"`
	Narrative Narrative `json:"narrative"`
}

var errNotFound = errors.New("not found")

// load gathers what the analysis needs; it reads, it never writes.
func load(ctx context.Context, pool *pgxpool.Pool, org, envID uuid.UUID, caps Capabilities) (input, error) {
	env, err := environment.New(pool).GetEnvironment(ctx, environment.GetEnvironmentParams{OrganizationID: org, ID: envID})
	if errors.Is(err, pgx.ErrNoRows) {
		return input{}, errNotFound
	}
	if err != nil {
		return input{}, err
	}
	proj, err := project.New(pool).GetProject(ctx, project.GetProjectParams{OrganizationID: org, ID: env.ProjectID})
	if err != nil {
		return input{}, err
	}
	in := input{Now: time.Now().UTC(), Project: proj.Name, LLM: caps.LLM, Storage: caps.Storage}
	in.Env = envInfo{Name: env.Name, BaseURL: env.BaseUrl, Policy: env.DestructivePolicy, Kind: env.Kind}
	if env.Device != nil {
		in.Env.Device = *env.Device
	}

	q := New(pool)
	gq := graph.New(pool)
	g, err := gq.GetLatestGraph(ctx, graph.GetLatestGraphParams{OrganizationID: org, EnvironmentID: envID})
	switch {
	case err == nil:
		in.GraphID = g.ID
		if in.Nodes, err = gq.ListNodes(ctx, graph.ListNodesParams{OrganizationID: org, GraphID: g.ID}); err != nil {
			return input{}, err
		}
		rows, err := gq.LatestNodeResults(ctx, graph.LatestNodeResultsParams{OrganizationID: org, EnvironmentID: envID, GraphID: g.ID})
		if err != nil {
			return input{}, err
		}
		in.NodeResults = map[uuid.UUID]string{}
		for _, row := range rows {
			status := "skipped"
			switch {
			case row.Failed > 0:
				status = "fail"
			case row.Errored > 0:
				status = "error"
			case row.Passed > 0:
				status = "pass"
			}
			in.NodeResults[row.NodeID] = status
		}
		if in.Edges, err = gq.ListEdges(ctx, graph.ListEdgesParams{OrganizationID: org, GraphID: g.ID}); err != nil {
			return input{}, err
		}
	case !errors.Is(err, pgx.ErrNoRows):
		return input{}, err
	}

	rows, err := q.BriefRequirements(ctx, BriefRequirementsParams{OrganizationID: org, ProjectID: env.ProjectID, EnvironmentID: uuid.NullUUID{UUID: envID, Valid: true}, GraphID: in.GraphID})
	if err != nil {
		return input{}, err
	}
	for _, r := range rows {
		in.Reqs = append(in.Reqs, reqRow{SpecTitle: r.SpecTitle, Source: r.SourceType, Key: r.Key, Text: r.Text, Criticality: r.Criticality, NodeIDs: r.NodeIds})
	}

	runs, err := run.New(pool).ListRuns(ctx, run.ListRunsParams{OrganizationID: org, EnvironmentID: envID})
	if err != nil {
		return input{}, err
	}
	for _, r := range runs { // newest first
		finished := r.Status == "succeeded" || r.Status == "failed"
		if !finished {
			continue
		}
		at := r.FinishedAt.Time
		if !r.FinishedAt.Valid {
			at = r.CreatedAt.Time
		}
		if in.Latest == nil {
			in.Latest = &runInfo{ID: r.ID, Type: r.Type, Status: r.Status, FinishedAt: at, Summary: r.Summary}
		}
		switch {
		case r.Type == "exploration" && r.Status == "succeeded" && in.Exploration == nil:
			in.Exploration = &runInfo{ID: r.ID, Type: r.Type, Status: r.Status, FinishedAt: at, Summary: r.Summary}
		case r.Type == "regression" && in.Regression == nil:
			rep, err := report.Build(ctx, pool, org, r.ID)
			if err != nil {
				return input{}, err
			}
			ri := &regressionInfo{ID: r.ID, FinishedAt: at, Report: rep}
			if r.GraphID.Valid {
				ri.GraphID = r.GraphID.UUID
			}
			ri.Roles = run.RolesOf(r.Budget)
			in.Regression = ri
		}
	}

	bq := bug.New(pool)
	bugs, err := bq.ListBugs(ctx, bug.ListBugsParams{OrganizationID: org, ProjectID: env.ProjectID})
	if err != nil {
		return input{}, err
	}
	ids := make([]uuid.UUID, 0, len(bugs))
	for _, b := range bugs {
		ids = append(ids, b.ID)
	}
	users := map[uuid.UUID][]string{}
	if len(ids) > 0 {
		pairs, err := bq.ListBugUsers(ctx, bug.ListBugUsersParams{OrganizationID: org, BugIds: ids})
		if err != nil {
			return input{}, err
		}
		for _, p := range pairs {
			if p.AppRole != "" {
				users[p.BugID] = append(users[p.BugID], p.AppRole)
			}
		}
	}
	for _, b := range bugs {
		in.Bugs = append(in.Bugs, bugRow{Title: b.Title, Severity: b.Severity, Status: b.Status, Category: b.Category, Users: users[b.ID]})
	}

	if in.Pendencies, err = openPendencies(ctx, q, org, env.ProjectID, envID); err != nil {
		return input{}, err
	}
	n, err := q.BriefRecentRunners(ctx, org)
	if err != nil {
		return input{}, err
	}
	in.Runners = int(n)
	return in, nil
}

func openPendencies(ctx context.Context, q *Queries, org, project, env uuid.UUID) (int, error) {
	n, err := q.BriefOpenPendencies(ctx, BriefOpenPendenciesParams{OrganizationID: org, ProjectID: project, EnvironmentID: uuid.NullUUID{UUID: env, Valid: true}})
	return int(n), err
}

// Register mounts the report. ai may be nil: the report then has the template text only.
func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool, ai Completer, caps Capabilities) {
	facts := func(w http.ResponseWriter, r *http.Request) (Facts, bool) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return Facts{}, false
		}
		in, err := load(r.Context(), pool, p.OrganizationID, eid, caps)
		if errors.Is(err, errNotFound) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return Facts{}, false
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return Facts{}, false
		}
		return analyze(in), true
	}

	// The report with the standard wording: instant, needs no model, and is what the page shows first.
	mux.Handle("GET /api/v1/environments/{id}/brief", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, ok := facts(w, r)
		if !ok {
			return
		}
		httpx.WriteJSON(w, http.StatusOK, response{Facts: f, Narrative: Template(f)})
	})))

	// The same report written by the model, in the same format; slower, so it is asked for.
	mux.Handle("POST /api/v1/environments/{id}/brief/narrative", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ai == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "LLM is not configured")
			return
		}
		f, ok := facts(w, r)
		if !ok {
			return
		}
		p, _ := auth.PrincipalFrom(r.Context())
		n, err := AINarrative(r.Context(), ai, p.OrganizationID, f)
		if errors.Is(err, llm.ErrInvalidOutput) {
			httpx.Error(w, http.StatusBadGateway, "the model returned a report that breaks the format")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusBadGateway, "the model could not write the report")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, response{Facts: f, Narrative: n})
	})))
}
