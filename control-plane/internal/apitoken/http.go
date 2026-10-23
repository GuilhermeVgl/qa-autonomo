// Package apitoken manages project API tokens used by CI (qactl) and authenticates them.
package apitoken

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
)

// Scopes a project token may carry.
const (
	ScopeRunCreate       = "run:create"
	ScopeRunRead         = "run:read"
	ScopeCredentialWrite = "credential:write"
)

var validScopes = map[string]bool{ScopeRunCreate: true, ScopeRunRead: true, ScopeCredentialWrite: true}

const prefix = "qat_"

// Principal is the authenticated project token.
type Principal struct {
	TokenID        uuid.UUID
	Name           string
	OrganizationID uuid.UUID
	ProjectID      uuid.UUID
	Scopes         []string
}

func (p Principal) Has(scope string) bool {
	for _, s := range p.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

type ctxKey struct{}

func From(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}

func hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Authenticate accepts only project tokens (qat_...) on the CI API.
func Authenticate(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	q := New(pool)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || !strings.HasPrefix(tok, prefix) {
				httpx.Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			row, err := q.GetAPITokenByHash(r.Context(), hash(tok))
			if err != nil {
				httpx.Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			_ = q.TouchAPIToken(r.Context(), row.ID)
			p := Principal{TokenID: row.ID, Name: row.Name, OrganizationID: row.OrganizationID, ProjectID: row.ProjectID, Scopes: row.Scopes}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, p)))
		})
	}
}

type view struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	Scopes     []string   `json:"scopes"`
	LastUsedAt *time.Time `json:"last_used_at"`
	Token      string     `json:"token,omitempty"` // only on creation
}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	q := New(pool)
	projects := project.New(pool)
	write := func(h http.HandlerFunc) http.Handler { return mw(auth.RequireWriter(h)) }

	mux.Handle("POST /api/v1/projects/{id}/tokens", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		pid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Name   string   `json:"name"`
			Scopes []string `json:"scopes"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" || len(in.Name) > 100 {
			httpx.Error(w, http.StatusBadRequest, "name is required (max 100 chars)")
			return
		}
		if len(in.Scopes) == 0 {
			in.Scopes = []string{ScopeRunCreate, ScopeRunRead}
		}
		for _, s := range in.Scopes {
			if !validScopes[s] {
				httpx.Error(w, http.StatusBadRequest, "unknown scope "+s)
				return
			}
		}
		if _, err := projects.GetProject(r.Context(), project.GetProjectParams{OrganizationID: p.OrganizationID, ID: pid}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				httpx.Error(w, http.StatusNotFound, "not found")
				return
			}
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		token := prefix + base64.RawURLEncoding.EncodeToString(raw)

		tx, err := pool.Begin(r.Context())
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer tx.Rollback(r.Context()) //nolint:errcheck // no-op after commit
		row, err := New(tx).CreateAPIToken(r.Context(), CreateAPITokenParams{
			OrganizationID: p.OrganizationID, ProjectID: pid, Name: in.Name, TokenHash: hash(token), Scopes: in.Scopes,
			CreatedBy: uuid.NullUUID{UUID: p.UserID, Valid: true},
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		payload, _ := json.Marshal(map[string]any{"name": in.Name, "scopes": in.Scopes, "project_id": pid})
		if err := audit.New(tx).RecordAudit(r.Context(), audit.RecordAuditParams{
			OrganizationID: p.OrganizationID, Actor: p.UserID.String(), Action: "token.create", Target: row.ID.String(), Payload: payload,
		}); err != nil || tx.Commit(r.Context()) != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, view{ID: row.ID, Name: row.Name, Scopes: row.Scopes, Token: token})
	}))

	mux.Handle("GET /api/v1/projects/{id}/tokens", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		pid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListAPITokens(r.Context(), ListAPITokensParams{OrganizationID: p.OrganizationID, ProjectID: pid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]view, 0, len(rows))
		for _, t := range rows {
			v := view{ID: t.ID, Name: t.Name, Scopes: t.Scopes}
			if t.LastUsedAt.Valid {
				v.LastUsedAt = &t.LastUsedAt.Time
			}
			out = append(out, v)
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("DELETE /api/v1/tokens/{id}", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		n, err := q.DeleteAPIToken(r.Context(), DeleteAPITokenParams{OrganizationID: p.OrganizationID, ID: id})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if n == 0 {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		_ = audit.New(pool).RecordAudit(r.Context(), audit.RecordAuditParams{
			OrganizationID: p.OrganizationID, Actor: p.UserID.String(), Action: "token.revoke", Target: id.String(), Payload: []byte(`{}`),
		})
		w.WriteHeader(http.StatusNoContent)
	}))
}
