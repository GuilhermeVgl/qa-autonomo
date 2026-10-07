package project_test

import (
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

func harness(t *testing.T) *testutil.Harness {
	return testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		project.Register(mux, mw, pool)
	})
}

type proj struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func TestProjects_CreateListGet(t *testing.T) {
	h := harness(t)
	owner := h.Login("o@x.com", "owner")

	rec := h.Do("POST", "/api/v1/projects", owner, map[string]string{"name": "Portal"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var created proj
	h.JSON(rec, &created)
	if created.Name != "Portal" || created.ID == "" {
		t.Fatalf("created = %+v", created)
	}

	var list []proj
	h.JSON(h.Do("GET", "/api/v1/projects", owner, nil), &list)
	if len(list) != 1 || list[0].ID != created.ID {
		t.Fatalf("list = %+v", list)
	}
	if c := h.Do("GET", "/api/v1/projects/"+created.ID, owner, nil).Code; c != http.StatusOK {
		t.Errorf("get = %d", c)
	}
	if c := h.Do("GET", "/api/v1/projects/00000000-0000-0000-0000-000000000000", owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("get missing = %d, want 404", c)
	}
	if c := h.Do("GET", "/api/v1/projects/not-a-uuid", owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("get invalid id = %d, want 404", c)
	}
}

func TestProjects_Validation_And_Authz(t *testing.T) {
	h := harness(t)
	owner := h.Login("o@x.com", "owner")
	viewer := h.Login("v@x.com", "viewer")

	if c := h.Do("POST", "/api/v1/projects", owner, map[string]string{"name": "  "}).Code; c != http.StatusBadRequest {
		t.Errorf("blank name = %d, want 400", c)
	}
	if c := h.Do("POST", "/api/v1/projects", viewer, map[string]string{"name": "X"}).Code; c != http.StatusForbidden {
		t.Errorf("viewer create = %d, want 403", c)
	}
	if c := h.Do("GET", "/api/v1/projects", viewer, nil).Code; c != http.StatusOK {
		t.Errorf("viewer list = %d, want 200", c)
	}
	if c := h.Do("GET", "/api/v1/projects", "", nil).Code; c != http.StatusUnauthorized {
		t.Errorf("anonymous = %d, want 401", c)
	}
}
