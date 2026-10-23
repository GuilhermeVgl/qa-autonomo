// Package ci is the API qactl talks to from pipelines: project-scoped tokens, no user session.
package ci

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/apitoken"
	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/report"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/secret"
)

type runView struct {
	run.View
	Link string `json:"link,omitempty"`
}

// Register mounts /ci/v1. publicURL (optional) is used to build the link to a run in the UI.
func Register(mux *http.ServeMux, pool *pgxpool.Pool, box *secret.Box, publicURL string) {
	auth := apitoken.Authenticate(pool)
	runs := run.New(pool)

	link := func(id uuid.UUID) string {
		if publicURL == "" {
			return ""
		}
		return publicURL + "/runs/" + id.String()
	}
	scoped := func(scope string, h http.HandlerFunc) http.Handler {
		return auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p, _ := apitoken.From(r.Context())
			if !p.Has(scope) {
				httpx.Error(w, http.StatusForbidden, "token lacks scope "+scope)
				return
			}
			h(w, r)
		}))
	}
	// ownRun loads a run only if it belongs to the token's project.
	ownRun := func(w http.ResponseWriter, r *http.Request) (run.Run, bool) {
		p, _ := apitoken.From(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return run.Run{}, false
		}
		rn, err := runs.GetRun(r.Context(), run.GetRunParams{OrganizationID: p.OrganizationID, ID: id})
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && rn.ProjectID != p.ProjectID) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return run.Run{}, false
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return run.Run{}, false
		}
		return rn, true
	}

	mux.Handle("POST /ci/v1/runs", scoped(apitoken.ScopeRunCreate, func(w http.ResponseWriter, r *http.Request) {
		p, _ := apitoken.From(r.Context())
		var in struct {
			Environment string     `json:"environment"` // name within the token's project
			Type        string     `json:"type"`
			Budget      run.Budget `json:"budget"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		if in.Type != "exploration" && in.Type != "regression" {
			httpx.Error(w, http.StatusBadRequest, "type must be exploration or regression")
			return
		}
		budget, err := in.Budget.Resolve()
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		env, err := environment.New(pool).GetEnvironmentByName(r.Context(), environment.GetEnvironmentByNameParams{OrganizationID: p.OrganizationID, ProjectID: p.ProjectID, Name: in.Environment})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "environment not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		created, err := run.Create(r.Context(), pool, run.CreateInput{
			OrganizationID: p.OrganizationID, Actor: "token:" + p.Name, Env: env, Type: in.Type, Trigger: "ci", Budget: budget,
		})
		switch {
		case errors.Is(err, run.ErrProduction):
			httpx.Error(w, http.StatusConflict, "production environments cannot be executed")
		case errors.Is(err, run.ErrNothingToTest):
			httpx.Error(w, http.StatusConflict, "nothing to test: explore the app and cross-reference it with a spec first")
		case err != nil:
			httpx.Error(w, http.StatusInternalServerError, "internal error")
		default:
			httpx.WriteJSON(w, http.StatusCreated, runView{View: run.ToView(created), Link: link(created.ID)})
		}
	}))

	mux.Handle("GET /ci/v1/runs/{id}", scoped(apitoken.ScopeRunRead, func(w http.ResponseWriter, r *http.Request) {
		rn, ok := ownRun(w, r)
		if !ok {
			return
		}
		httpx.WriteJSON(w, http.StatusOK, runView{View: run.ToView(rn), Link: link(rn.ID)})
	}))

	mux.Handle("GET /ci/v1/runs/{id}/report", scoped(apitoken.ScopeRunRead, func(w http.ResponseWriter, r *http.Request) {
		rn, ok := ownRun(w, r)
		if !ok {
			return
		}
		out, err := report.Build(r.Context(), pool, rn.OrganizationID, rn.ID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	}))

	// Upsert a captured browser session (kind=session), so `npm run capture` can save it with a project token.
	mux.Handle("PUT /ci/v1/credentials/session", scoped(apitoken.ScopeCredentialWrite, func(w http.ResponseWriter, r *http.Request) {
		p, _ := apitoken.From(r.Context())
		var in struct {
			Environment string `json:"environment"` // name within the token's project
			AppRole     string `json:"app_role"`
			State       string `json:"state"` // a Playwright storageState JSON
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		in.AppRole = strings.TrimSpace(in.AppRole)
		if in.Environment == "" || in.AppRole == "" || in.State == "" {
			httpx.Error(w, http.StatusBadRequest, "environment, app_role and state are required")
			return
		}
		env, err := environment.New(pool).GetEnvironmentByName(r.Context(), environment.GetEnvironmentByNameParams{OrganizationID: p.OrganizationID, ProjectID: p.ProjectID, Name: in.Environment})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "environment not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		plain, _ := json.Marshal(map[string]string{"state": in.State})
		sealed, err := box.Seal(plain)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		tx, err := pool.Begin(r.Context())
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer tx.Rollback(r.Context()) //nolint:errcheck // no-op after commit
		if _, err := environment.New(tx).UpsertCredential(r.Context(), environment.UpsertCredentialParams{
			OrganizationID: p.OrganizationID, EnvironmentID: env.ID, AppRole: in.AppRole, Kind: "session", PayloadEncrypted: sealed,
		}); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		auditPayload, _ := json.Marshal(map[string]string{"app_role": in.AppRole, "kind": "session"}) // never the session itself
		if err := audit.New(tx).RecordAudit(r.Context(), audit.RecordAuditParams{
			OrganizationID: p.OrganizationID, Actor: "token:" + p.Name, Action: "credential.upsert", Target: env.ID.String(), Payload: auditPayload,
		}); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
}
