// Package report builds the per-run report: results, requirement outcomes, bugs and cost (CLAUDE.md, seção 8.7).
package report

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/bug"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
)

type runInfo struct {
	ID              uuid.UUID  `json:"id"`
	Type            string     `json:"type"`
	Status          string     `json:"status"`
	StartedAt       *time.Time `json:"started_at"`
	FinishedAt      *time.Time `json:"finished_at"`
	DurationSeconds float64    `json:"duration_seconds"`
	// SpecID is set when the run was limited to one spec.
	SpecID *uuid.UUID `json:"spec_id,omitempty"`
}

// RequirementOutcome is the verdict of one requirement in a run.
type RequirementOutcome struct {
	Key         string `json:"key"`
	Text        string `json:"text"`
	Criticality string `json:"criticality"`
	Outcome     string `json:"outcome"` // pass | fail | error | skipped
	// ByUser is the verdict per tested user: a requirement can pass for one user and fail for another.
	ByUser map[string]string `json:"by_user"`
}

// UserOutcome is what one tested user got in a run. An empty user is a check that belongs to no user (an API call).
type UserOutcome struct {
	User    string `json:"user"`
	Passed  int    `json:"passed"`
	Failed  int    `json:"failed"`
	Errored int    `json:"errored"`
	Skipped int    `json:"skipped"`
}

type bugGroups struct {
	New       []bug.View `json:"new"`       // 🔴 first seen in this run
	Recurring []bug.View `json:"recurring"` // 🟠 seen before and again here
	Fixed     []bug.View `json:"fixed"`     // 🟢 failed before and passed in this run
}

type cost struct {
	LLMCalls  int     `json:"llm_calls"`
	TokensIn  int64   `json:"tokens_in"`
	TokensOut int64   `json:"tokens_out"`
	Cost      float64 `json:"cost"`
}

// SecuritySummary is what the security checks of a run came to: they run inside explorations and regressions, and are
// counted apart from the tests of the requirements.
type SecuritySummary struct {
	Checks int `json:"checks"`
	Passed int `json:"passed"`
	Failed int `json:"failed"`
	// BySeverity counts the failures by how serious they are (critical, high, normal).
	BySeverity map[string]int `json:"by_severity"`
}

// Report is the per-run report.
type Report struct {
	Run          runInfo              `json:"run"`
	Summary      any                  `json:"summary"`
	Steps        map[string]int       `json:"steps"`
	Users        []UserOutcome        `json:"users"`
	Requirements []RequirementOutcome `json:"requirements"`
	Security     SecuritySummary      `json:"security"`
	Bugs         bugGroups            `json:"bugs"`
	Cost         cost                 `json:"cost"`
}

// ErrNotFound means the run does not exist in the organization.
var ErrNotFound = errors.New("run not found")

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	mux.Handle("GET /api/v1/runs/{id}/report", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		out, err := Build(r.Context(), pool, p.OrganizationID, id)
		if errors.Is(err, ErrNotFound) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))
}

// Build assembles the report of one run: steps, requirement outcomes, bugs (new/recurring/fixed) and LLM cost.
func Build(ctx context.Context, pool *pgxpool.Pool, org, id uuid.UUID) (Report, error) {
	q, runs, bugs := New(pool), run.New(pool), bug.New(pool)
	rn, err := runs.GetRun(ctx, run.GetRunParams{OrganizationID: org, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return Report{}, ErrNotFound
	}
	if err != nil {
		return Report{}, err
	}

	out := Report{Run: runInfo{ID: rn.ID, Type: rn.Type, Status: rn.Status}, Summary: rn.Summary, Steps: map[string]int{"pass": 0, "fail": 0, "error": 0, "skipped": 0, "running": 0},
		Users: []UserOutcome{}, Requirements: []RequirementOutcome{}, Security: SecuritySummary{BySeverity: map[string]int{"critical": 0, "high": 0, "normal": 0}}, Bugs: bugGroups{New: []bug.View{}, Recurring: []bug.View{}, Fixed: []bug.View{}}}
	if rn.StartedAt.Valid {
		out.Run.StartedAt = &rn.StartedAt.Time
	}
	if rn.FinishedAt.Valid {
		out.Run.FinishedAt = &rn.FinishedAt.Time
	}
	if rn.StartedAt.Valid && rn.FinishedAt.Valid {
		out.Run.DurationSeconds = rn.FinishedAt.Time.Sub(rn.StartedAt.Time).Seconds()
	}

	counts, err := q.CountStepsByResult(ctx, CountStepsByResultParams{OrganizationID: org, RunID: id})
	if err != nil {
		return Report{}, err
	}
	for _, c := range counts {
		out.Steps[c.Result] = int(c.N)
	}
	checks, err := q.CountSecurityChecks(ctx, CountSecurityChecksParams{OrganizationID: org, RunID: id})
	if err != nil {
		return Report{}, err
	}
	for _, c := range checks {
		switch c.Result {
		case "pass":
			out.Security.Checks += int(c.N)
			out.Security.Passed += int(c.N)
		case "fail", "error":
			out.Security.Checks += int(c.N)
			out.Security.Failed += int(c.N)
			out.Security.BySeverity[c.Severity] += int(c.N)
		}
	}
	scope := run.SpecScope(rn.Budget)
	if scope.Valid {
		out.Run.SpecID = &scope.UUID
	}
	reqs, err := q.ListRequirementOutcomes(ctx, ListRequirementOutcomesParams{OrganizationID: org, RunID: id, SpecID: scope})
	if err != nil {
		return Report{}, err
	}
	byUser, err := q.ListRequirementOutcomesByUser(ctx, ListRequirementOutcomesByUserParams{OrganizationID: org, RunID: id, SpecID: scope})
	if err != nil {
		return Report{}, err
	}
	perReq := map[string]map[string]string{}
	for _, b := range byUser {
		if perReq[b.Key] == nil {
			perReq[b.Key] = map[string]string{}
		}
		perReq[b.Key][b.AppRole] = b.Outcome
	}
	for _, rq := range reqs {
		ro := RequirementOutcome{Key: rq.Key, Text: rq.Text, Criticality: rq.Criticality, Outcome: rq.Outcome, ByUser: perReq[rq.Key]}
		if ro.ByUser == nil {
			ro.ByUser = map[string]string{}
		}
		out.Requirements = append(out.Requirements, ro)
	}
	users, err := q.CountStepsByUser(ctx, CountStepsByUserParams{OrganizationID: org, RunID: id})
	if err != nil {
		return Report{}, err
	}
	idx := map[string]int{}
	for _, u := range users {
		i, ok := idx[u.AppRole]
		if !ok {
			i = len(out.Users)
			idx[u.AppRole] = i
			out.Users = append(out.Users, UserOutcome{User: u.AppRole})
		}
		switch u.Result {
		case "pass":
			out.Users[i].Passed += int(u.N)
		case "fail":
			out.Users[i].Failed += int(u.N)
		case "error":
			out.Users[i].Errored += int(u.N)
		case "skipped":
			out.Users[i].Skipped += int(u.N)
		}
	}
	sort.Slice(out.Users, func(a, b int) bool { return out.Users[a].User < out.Users[b].User })

	seen, err := bugs.ListBugsSeenInRun(ctx, bug.ListBugsSeenInRunParams{OrganizationID: org, RunID: id})
	if err != nil {
		return Report{}, err
	}
	for _, b := range seen {
		if b.FirstSeenRunID == id {
			out.Bugs.New = append(out.Bugs.New, bug.ToView(b))
		} else {
			out.Bugs.Recurring = append(out.Bugs.Recurring, bug.ToView(b))
		}
	}
	fixed, err := bugs.ListBugsFixedInRun(ctx, bug.ListBugsFixedInRunParams{OrganizationID: org, FixedInRunID: uuid.NullUUID{UUID: id, Valid: true}})
	if err != nil {
		return Report{}, err
	}
	for _, b := range fixed {
		out.Bugs.Fixed = append(out.Bugs.Fixed, bug.ToView(b))
	}

	c, err := q.RunLLMCost(ctx, RunLLMCostParams{OrganizationID: org, RunID: uuid.NullUUID{UUID: id, Valid: true}})
	if err != nil {
		return Report{}, err
	}
	out.Cost = cost{LLMCalls: int(c.Calls), TokensIn: c.TokensIn, TokensOut: c.TokensOut, Cost: c.Cost}
	return out, nil
}
