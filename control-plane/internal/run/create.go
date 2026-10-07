package run

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
)

var (
	ErrProduction    = errors.New("production environments cannot be executed")
	ErrNothingToTest = errors.New("no covered nodes to test")
	// ErrUnknownUser means a run asked to run as a user the environment has no credentials for.
	ErrUnknownUser = errors.New("unknown user: the environment has no credentials for it")
	// ErrNothingToResume means there is no interrupted exploration to continue.
	ErrNothingToResume = errors.New("no interrupted exploration to continue")
	// ErrResumeOnRegression means a regression was asked to continue: only explorations have something to resume.
	ErrResumeOnRegression = errors.New("only an exploration can be continued")
)

// CreateInput is everything the three triggers (manual, schedule, ci) share (CLAUDE.md, seção 8.6).
type CreateInput struct {
	OrganizationID uuid.UUID
	Actor          string // audit actor: a user id, "token:<name>" or "scheduler"
	Env            environment.Environment
	Type           string // exploration | regression
	Trigger        string // manual | schedule | ci
	Budget         Budget // already resolved
}

// Create is the single domain function that creates a queued run, whoever asked for it.
// Exploration creates a new graph version; regression reuses the latest graph and needs covered nodes.
// RequiredLabels are the runner labels a run of this environment needs: terminal environments only run on
// ephemeral terminal runners, and on the one that carries the environment's image when it names one.
func RequiredLabels(env environment.Environment) []string {
	if env.Kind != "terminal" {
		return []string{}
	}
	labels := []string{"terminal"}
	if env.TerminalImage != nil && *env.TerminalImage != "" {
		labels = append(labels, "image:"+*env.TerminalImage)
	}
	return labels
}

func Create(ctx context.Context, pool *pgxpool.Pool, in CreateInput) (Run, error) {
	if in.Env.IsProduction {
		return Run{}, ErrProduction
	}
	if in.Budget.Resume && in.Type != "exploration" {
		return Run{}, ErrResumeOnRegression
	}
	switch in.Type {
	case "exploration":
		return createExploration(ctx, pool, in)
	case "regression":
		return createRegression(ctx, pool, in)
	default:
		return Run{}, fmt.Errorf("unsupported run type %q", in.Type)
	}
}

// checkUsers makes sure every user a run asks to run as has credentials in the environment.
func checkUsers(ctx context.Context, pool *pgxpool.Pool, in CreateInput) error {
	if len(in.Budget.Roles) == 0 {
		return nil
	}
	creds, err := environment.New(pool).ListCredentials(ctx, environment.ListCredentialsParams{OrganizationID: in.OrganizationID, EnvironmentID: in.Env.ID})
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, c := range creds {
		known[c.AppRole] = true
	}
	for _, r := range in.Budget.Roles {
		if !known[r] {
			return ErrUnknownUser
		}
	}
	return nil
}

func audited(ctx context.Context, q *audit.Queries, in CreateInput, created Run, extra map[string]any) error {
	extra["type"], extra["trigger"] = in.Type, in.Trigger
	payload, _ := json.Marshal(extra)
	return q.RecordAudit(ctx, audit.RecordAuditParams{OrganizationID: in.OrganizationID, Actor: in.Actor, Action: "run.create", Target: created.ID.String(), Payload: payload})
}

// resumable says whether an exploration stopped before it was done: cancelled, failed, or out of time or pages.
func resumable(r Run) bool {
	switch r.Status {
	case "cancelled", "failed":
		return true
	case "succeeded":
		var s struct {
			StoppedBy string `json:"stopped_by"`
		}
		_ = json.Unmarshal(r.Summary, &s)
		return s.StoppedBy == "max_pages" || s.StoppedBy == "max_seconds" || s.StoppedBy == "cancelled"
	}
	return false
}

// createResume queues a continuation of the last exploration: same graph, so nothing found so far is lost.
func createResume(ctx context.Context, pool *pgxpool.Pool, in CreateInput) (Run, error) {
	if err := checkUsers(ctx, pool, in); err != nil {
		return Run{}, err
	}
	g, err := graph.New(pool).GetLatestGraph(ctx, graph.GetLatestGraphParams{OrganizationID: in.OrganizationID, EnvironmentID: in.Env.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNothingToResume
	}
	if err != nil {
		return Run{}, err
	}
	last, err := New(pool).GetLatestExplorationRunOfGraph(ctx, GetLatestExplorationRunOfGraphParams{OrganizationID: in.OrganizationID, GraphID: uuidNull(g.ID)})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !resumable(last)) {
		return Run{}, ErrNothingToResume
	}
	if err != nil {
		return Run{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	b, _ := json.Marshal(in.Budget)
	created, err := New(tx).CreateRun(ctx, CreateRunParams{
		OrganizationID: in.OrganizationID, ProjectID: in.Env.ProjectID, EnvironmentID: in.Env.ID,
		GraphID: uuidNull(g.ID), Type: "exploration", Trigger: in.Trigger, Budget: b, RequiredLabels: RequiredLabels(in.Env),
	})
	if err != nil {
		return Run{}, err
	}
	extra := map[string]any{"resume_of": last.ID}
	if len(in.Budget.Roles) > 0 {
		extra["users"] = in.Budget.Roles
	}
	if err := audited(ctx, audit.New(tx), in, created, extra); err != nil {
		return Run{}, err
	}
	return created, tx.Commit(ctx)
}

func createExploration(ctx context.Context, pool *pgxpool.Pool, in CreateInput) (Run, error) {
	if in.Budget.Resume {
		return createResume(ctx, pool, in)
	}
	if err := checkUsers(ctx, pool, in); err != nil {
		return Run{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	gq := graph.New(tx)
	prev, prevErr := gq.GetLatestGraph(ctx, graph.GetLatestGraphParams{OrganizationID: in.OrganizationID, EnvironmentID: in.Env.ID})
	if prevErr != nil && !errors.Is(prevErr, pgx.ErrNoRows) {
		return Run{}, prevErr
	}
	version, err := gq.NextGraphVersion(ctx, graph.NextGraphVersionParams{OrganizationID: in.OrganizationID, EnvironmentID: in.Env.ID})
	if err != nil {
		return Run{}, err
	}
	g, err := gq.CreateGraph(ctx, graph.CreateGraphParams{OrganizationID: in.OrganizationID, ProjectID: in.Env.ProjectID, EnvironmentID: in.Env.ID, Version: version})
	if err != nil {
		return Run{}, err
	}
	// endpoint nodes come from OpenAPI specs, not from exploring: carry them (and their links) forward
	if prevErr == nil {
		if err := gq.CopyEndpointNodes(ctx, graph.CopyEndpointNodesParams{Org: in.OrganizationID, FromGraph: prev.ID, ToGraph: g.ID}); err != nil {
			return Run{}, err
		}
		if err := gq.CopyEndpointLinks(ctx, graph.CopyEndpointLinksParams{Org: in.OrganizationID, FromGraph: prev.ID, ToGraph: g.ID}); err != nil {
			return Run{}, err
		}
		if err := carryOtherUsers(ctx, gq, in, prev.ID, g.ID); err != nil {
			return Run{}, err
		}
	}
	b, _ := json.Marshal(in.Budget)
	created, err := New(tx).CreateRun(ctx, CreateRunParams{
		OrganizationID: in.OrganizationID, ProjectID: in.Env.ProjectID, EnvironmentID: in.Env.ID,
		GraphID: uuidNull(g.ID), Type: "exploration", Trigger: in.Trigger, Budget: b, RequiredLabels: RequiredLabels(in.Env),
	})
	if err != nil {
		return Run{}, err
	}
	if err := gq.SetGraphSourceRun(ctx, graph.SetGraphSourceRunParams{OrganizationID: in.OrganizationID, ID: g.ID, SourceRunID: uuidNull(created.ID)}); err != nil {
		return Run{}, err
	}
	extra := map[string]any{}
	if len(in.Budget.Roles) > 0 {
		extra["users"] = in.Budget.Roles
	}
	if err := audited(ctx, audit.New(tx), in, created, extra); err != nil {
		return Run{}, err
	}
	return created, tx.Commit(ctx)
}

// carryOtherUsers keeps, in the graph of an exploration of only some users, what was mapped for the others (their
// screens with pictures, the links between them and what was linked to them). A complete exploration starts clean.
func carryOtherUsers(ctx context.Context, gq *graph.Queries, in CreateInput, from, to uuid.UUID) error {
	if len(in.Budget.Roles) == 0 {
		return nil
	}
	if err := gq.CopyNodesOfOtherUsers(ctx, graph.CopyNodesOfOtherUsersParams{Org: in.OrganizationID, FromGraph: from, ToGraph: to, Explored: in.Budget.Roles, Keep: []string{}}); err != nil {
		return err
	}
	if err := gq.CopyEdgesOfOtherUsers(ctx, graph.CopyEdgesOfOtherUsersParams{Org: in.OrganizationID, FromGraph: from, ToGraph: to, Explored: in.Budget.Roles, Keep: []string{}}); err != nil {
		return err
	}
	return gq.CopyLinksOfOtherUsers(ctx, graph.CopyLinksOfOtherUsersParams{Org: in.OrganizationID, FromGraph: from, ToGraph: to, Explored: in.Budget.Roles, Keep: []string{}})
}

func createRegression(ctx context.Context, pool *pgxpool.Pool, in CreateInput) (Run, error) {
	g, err := graph.New(pool).GetLatestGraph(ctx, graph.GetLatestGraphParams{OrganizationID: in.OrganizationID, EnvironmentID: in.Env.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNothingToTest
	}
	if err != nil {
		return Run{}, err
	}
	if err := checkUsers(ctx, pool, in); err != nil {
		return Run{}, err
	}
	var target []uuid.UUID // empty: every covered node; a spec or a choice of users narrows it
	nCovered := 0
	type coveredNode struct {
		id    uuid.UUID
		roles []string
	}
	var covered []coveredNode
	if in.Budget.SpecID != nil {
		nodes, err := New(pool).ListCoveredNodesForSpec(ctx, ListCoveredNodesForSpecParams{OrganizationID: in.OrganizationID, GraphID: g.ID, SpecID: *in.Budget.SpecID})
		if err != nil {
			return Run{}, err
		}
		for _, n := range nodes {
			covered = append(covered, coveredNode{n.ID, n.AppRoles})
		}
	} else {
		nodes, err := New(pool).ListCoveredNodes(ctx, ListCoveredNodesParams{OrganizationID: in.OrganizationID, GraphID: g.ID})
		if err != nil {
			return Run{}, err
		}
		for _, n := range nodes {
			covered = append(covered, coveredNode{n.ID, n.AppRoles})
		}
	}
	restricted := in.Budget.SpecID != nil || len(in.Budget.Roles) > 0
	for _, n := range covered {
		if len(in.Budget.Roles) > 0 && !slices.ContainsFunc(n.roles, func(r string) bool { return slices.Contains(in.Budget.Roles, r) }) {
			continue
		}
		nCovered++
		if restricted {
			target = append(target, n.id)
		}
	}
	if nCovered == 0 {
		return Run{}, ErrNothingToTest
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return Run{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	b, _ := json.Marshal(in.Budget)
	created, err := New(tx).CreateRegressionRun(ctx, CreateRegressionRunParams{
		OrganizationID: in.OrganizationID, ProjectID: in.Env.ProjectID, EnvironmentID: in.Env.ID, GraphID: uuidNull(g.ID), Trigger: in.Trigger, Budget: b, RequiredLabels: RequiredLabels(in.Env), TargetNodeIds: target,
	})
	if err != nil {
		return Run{}, err
	}
	extra := map[string]any{"targets": nCovered}
	if len(in.Budget.Roles) > 0 {
		extra["users"] = in.Budget.Roles
	}
	if in.Budget.SpecID != nil {
		extra["spec_id"] = *in.Budget.SpecID
	}
	if err := audited(ctx, audit.New(tx), in, created, extra); err != nil {
		return Run{}, err
	}
	return created, tx.Commit(ctx)
}
