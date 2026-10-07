// Package run creates and manages runs (exploration now; regression later).
package run

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
)

// Budget limits an exploration (CLAUDE.md 8.2). Cost budget arrives with LLM-driven exploration.
type Budget struct {
	MaxPages   int `json:"max_pages"`
	MaxDepth   int `json:"max_depth"`
	MaxSeconds int `json:"max_seconds"`
	// MaxLLMCalls bounds the LLM-guided planning of an exploration; past it the runner falls back to the default order.
	MaxLLMCalls int `json:"max_llm_calls"`
	// MaxActions bounds what the agent does in the browser besides following links: clicks and form submissions.
	MaxActions int `json:"max_actions"`
	// SpecID limits a regression to the requirements of one spec: only the nodes linked to them are tested and the
	// report lists only them. Set by the server from the request, never taken from the budget the client sends.
	SpecID *uuid.UUID `json:"spec_id,omitempty"`
	// Roles are the users (credentials of the environment) a run works as. Empty means every user. The run keeps the
	// list so the report can say who was tested or explored; an exploration of some users keeps the map of the others.
	Roles []string `json:"roles,omitempty"`
	// NoSecurity turns the security checks off for the run. They are part of every exploration and regression by default.
	NoSecurity bool `json:"no_security,omitempty"`
	// Resume (exploration only) continues the last exploration on the same graph instead of starting a new one: what was
	// already examined is skipped and the budget counts only new screens.
	Resume bool `json:"resume,omitempty"`
	// Concurrency is how many browsers check screens at once for each user in a regression (default 1: some applications end
	// the first session when the same user logs in again).
	Concurrency int `json:"concurrency,omitempty"`
}

const (
	maxRoles       = 20
	maxConcurrency = 6
)

// SpecScope is the spec a run was limited to, if any.
func SpecScope(budget []byte) uuid.NullUUID {
	var b struct {
		SpecID *uuid.UUID `json:"spec_id"`
	}
	if json.Unmarshal(budget, &b) != nil || b.SpecID == nil {
		return uuid.NullUUID{}
	}
	return uuid.NullUUID{UUID: *b.SpecID, Valid: true}
}

// RolesOf is the users a run was limited to, if any (empty: every user).
func RolesOf(budget []byte) []string {
	var b struct {
		Roles []string `json:"roles"`
	}
	if json.Unmarshal(budget, &b) != nil {
		return nil
	}
	return b.Roles
}

// IsResume says whether an exploration continues the previous one.
func IsResume(budget []byte) bool {
	var b struct {
		Resume bool `json:"resume"`
	}
	return json.Unmarshal(budget, &b) == nil && b.Resume
}

var defaultBudget = Budget{MaxPages: 50, MaxDepth: 4, MaxSeconds: 900, MaxLLMCalls: 30, MaxActions: 60}

const (
	maxPages    = 2000
	maxDepth    = 15
	maxSeconds  = 14400 // 4 h: big applications need hours, and the lease is kept alive by the runner's heartbeat
	maxLLMCalls = 200
	maxActions  = 2000
)

// resolve fills zero fields with defaults and rejects out-of-range values.
func (b Budget) Resolve() (Budget, error) {
	if b.MaxPages < 0 || b.MaxDepth < 0 || b.MaxSeconds < 0 || b.MaxLLMCalls < 0 || b.MaxActions < 0 ||
		b.Concurrency < 0 || b.Concurrency > maxConcurrency || b.MaxPages > maxPages || b.MaxDepth > maxDepth || b.MaxSeconds > maxSeconds || b.MaxLLMCalls > maxLLMCalls || b.MaxActions > maxActions {
		return Budget{}, errors.New("budget out of range")
	}
	roles, err := cleanRoles(b.Roles)
	if err != nil {
		return Budget{}, err
	}
	b.Roles = roles
	if b.MaxPages == 0 {
		b.MaxPages = defaultBudget.MaxPages
	}
	if b.MaxDepth == 0 {
		b.MaxDepth = defaultBudget.MaxDepth
	}
	if b.MaxSeconds == 0 {
		b.MaxSeconds = defaultBudget.MaxSeconds
	}
	if b.MaxLLMCalls == 0 {
		b.MaxLLMCalls = defaultBudget.MaxLLMCalls
	}
	if b.MaxActions == 0 {
		b.MaxActions = defaultBudget.MaxActions
	}
	return b, nil
}

// cleanRoles trims, drops empties and repeats, and bounds the list.
func cleanRoles(in []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, r := range in {
		r = strings.TrimSpace(r)
		if r == "" || seen[r] {
			continue
		}
		if len([]rune(r)) > 80 {
			return nil, errors.New("user name too long")
		}
		seen[r] = true
		out = append(out, r)
	}
	if len(out) > maxRoles {
		return nil, fmt.Errorf("at most %d users per run", maxRoles)
	}
	return out, nil
}

type View struct {
	ID            uuid.UUID       `json:"id"`
	EnvironmentID uuid.UUID       `json:"environment_id"`
	GraphID       *uuid.UUID      `json:"graph_id"`
	Type          string          `json:"type"`
	Trigger       string          `json:"trigger"`
	Status        string          `json:"status"`
	Budget        json.RawMessage `json:"budget"`
	Summary       json.RawMessage `json:"summary"`
	CreatedAt     *time.Time      `json:"created_at"`
	StartedAt     *time.Time      `json:"started_at"`
	FinishedAt    *time.Time      `json:"finished_at"`
}

func timeOrNil(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}

func ToView(r Run) View {
	v := View{ID: r.ID, EnvironmentID: r.EnvironmentID, Type: r.Type, Trigger: r.Trigger, Status: r.Status, Budget: r.Budget, Summary: r.Summary,
		CreatedAt: timeOrNil(r.CreatedAt), StartedAt: timeOrNil(r.StartedAt), FinishedAt: timeOrNil(r.FinishedAt)}
	if r.GraphID.Valid {
		v.GraphID = &r.GraphID.UUID
	}
	return v
}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	q := New(pool)
	envs := environment.New(pool)
	write := func(h http.HandlerFunc) http.Handler { return mw(auth.RequireWriter(h)) }

	mux.Handle("POST /api/v1/environments/{id}/runs", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Type   string     `json:"type"`
			Budget Budget     `json:"budget"`
			SpecID *uuid.UUID `json:"spec_id"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		if in.Type != "exploration" && in.Type != "regression" {
			httpx.Error(w, http.StatusBadRequest, "type must be exploration or regression")
			return
		}
		if in.SpecID != nil && in.Type != "regression" {
			httpx.Error(w, http.StatusBadRequest, "spec_id only applies to regression runs")
			return
		}
		in.Budget.SpecID = nil // the scope comes from spec_id, checked below
		budget, err := in.Budget.Resolve()
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		env, err := envs.GetEnvironment(r.Context(), environment.GetEnvironmentParams{OrganizationID: p.OrganizationID, ID: eid})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		if in.SpecID != nil {
			sp, err := spec.New(pool).GetSpec(r.Context(), spec.GetSpecParams{OrganizationID: p.OrganizationID, ID: *in.SpecID})
			if err != nil || sp.ProjectID != env.ProjectID {
				httpx.Error(w, http.StatusNotFound, "spec not found")
				return
			}
			budget.SpecID = in.SpecID
		}
		created, err := Create(r.Context(), pool, CreateInput{
			OrganizationID: p.OrganizationID, Actor: p.UserID.String(), Env: env, Type: in.Type, Trigger: "manual", Budget: budget,
		})
		if errors.Is(err, ErrProduction) {
			httpx.Error(w, http.StatusConflict, "production environments cannot be executed")
			return
		}
		if errors.Is(err, ErrUnknownUser) || errors.Is(err, ErrResumeOnRegression) {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		if errors.Is(err, ErrNothingToResume) {
			httpx.Error(w, http.StatusConflict, "nothing to continue: the last exploration finished or there is none")
			return
		}
		if errors.Is(err, ErrNothingToTest) {
			httpx.Error(w, http.StatusConflict, "nothing to test: explore the app and cross-reference it with a spec first")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, ToView(created))
	}))

	mux.Handle("GET /api/v1/runs/{id}", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		row, err := q.GetRun(r.Context(), GetRunParams{OrganizationID: p.OrganizationID, ID: id})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, ToView(row))
	})))

	mux.Handle("GET /api/v1/environments/{id}/runs", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListRuns(r.Context(), ListRunsParams{OrganizationID: p.OrganizationID, EnvironmentID: eid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]View, 0, len(rows))
		for _, row := range rows {
			out = append(out, ToView(row))
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("POST /api/v1/runs/{id}/cancel", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		row, err := q.CancelRun(r.Context(), CancelRunParams{OrganizationID: p.OrganizationID, ID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			// either missing or already finished
			if _, getErr := q.GetRun(r.Context(), GetRunParams{OrganizationID: p.OrganizationID, ID: id}); getErr == nil {
				httpx.Error(w, http.StatusConflict, "run already finished")
				return
			}
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, ToView(row))
	}))
}

func uuidNull(id uuid.UUID) uuid.NullUUID { return uuid.NullUUID{UUID: id, Valid: true} }

func notFoundOr500(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not found")
		return
	}
	httpx.Error(w, http.StatusInternalServerError, "internal error")
}
