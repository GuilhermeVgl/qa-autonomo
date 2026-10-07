package testutil

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/org"
)

// Harness is an in-process API over a real Postgres, authenticated with dev tokens.
type Harness struct {
	T     *testing.T
	Pool  *pgxpool.Pool
	Mux   *http.ServeMux
	OrgID uuid.UUID
	Svc   *auth.Service
}

// NewHarness creates one organization and lets register mount the routes under test.
func NewHarness(t *testing.T, register func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool)) *Harness {
	t.Helper()
	pool := NewPool(t)
	o, err := org.New(pool).EnsureOrganization(context.Background(), org.EnsureOrganizationParams{Name: "KPMG", Slug: "kpmg"})
	if err != nil {
		t.Fatal(err)
	}
	svc := auth.NewService(pool, o.ID)
	mux := http.NewServeMux()
	register(mux, auth.Middleware(auth.DevVerifier{}, svc), pool)
	return &Harness{T: t, Pool: pool, Mux: mux, OrgID: o.ID, Svc: svc}
}

// Login provisions the user and forces its role (the first user is always owner).
func (h *Harness) Login(email, role string) string {
	h.T.Helper()
	token := "dev:" + email
	id, _ := auth.DevVerifier{}.Verify(context.Background(), token)
	p, err := h.Svc.Login(context.Background(), id)
	if err != nil {
		h.T.Fatal(err)
	}
	if _, err := h.Pool.Exec(context.Background(), `UPDATE memberships SET role = $1 WHERE user_id = $2`, role, p.UserID); err != nil {
		h.T.Fatal(err)
	}
	return token
}

// Do sends a JSON request; body may be nil. It returns the recorder.
func (h *Harness) Do(method, path, token string, body any) *httptest.ResponseRecorder {
	h.T.Helper()
	return h.DoWith(method, path, token, body, nil)
}

// DoWith is Do plus extra request headers.
func (h *Harness) DoWith(method, path, token string, body any, headers map[string]string) *httptest.ResponseRecorder {
	h.T.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			h.T.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.Mux.ServeHTTP(rec, req)
	return rec
}

// JSON decodes a recorder body into v.
func (h *Harness) JSON(rec *httptest.ResponseRecorder, v any) {
	h.T.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		h.T.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
}
