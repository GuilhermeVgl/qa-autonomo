package auth_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/org"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fakeVerifier struct{}

func (fakeVerifier) Verify(_ context.Context, token string) (auth.Identity, error) {
	if token == "" || token == "bad" {
		return auth.Identity{}, errors.New("invalid token")
	}
	return auth.Identity{Subject: token, Email: token + "@x.com"}, nil
}

func newMux(t *testing.T) *http.ServeMux {
	t.Helper()
	pool := testutil.NewPool(t)
	o, err := org.New(pool).EnsureOrganization(context.Background(), org.EnsureOrganizationParams{Name: "KPMG", Slug: "kpmg"})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	auth.Register(mux, fakeVerifier{}, auth.NewService(pool, o.ID))
	return mux
}

func do(mux *http.ServeMux, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestMe_RequiresValidTokenAndKnownUser(t *testing.T) {
	mux := newMux(t)
	if c := do(mux, "GET", "/api/v1/me", "").Code; c != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", c)
	}
	if c := do(mux, "GET", "/api/v1/me", "bad").Code; c != http.StatusUnauthorized {
		t.Errorf("bad token = %d, want 401", c)
	}
	if c := do(mux, "GET", "/api/v1/me", "ana").Code; c != http.StatusUnauthorized {
		t.Errorf("valid token but never logged in = %d, want 401", c)
	}
}

func TestLoginThenMe(t *testing.T) {
	mux := newMux(t)
	if c := do(mux, "POST", "/api/v1/auth/login", "ana").Code; c != http.StatusOK {
		t.Fatalf("login = %d, want 200", c)
	}
	rec := do(mux, "GET", "/api/v1/me", "ana")
	if rec.Code != http.StatusOK {
		t.Fatalf("me = %d, want 200", rec.Code)
	}
	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Email != "ana@x.com" || body.Role != "owner" {
		t.Errorf("body = %+v", body)
	}
}
