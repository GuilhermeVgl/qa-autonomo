package spec_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fakeExtractor struct {
	out      []spec.Item
	err      error
	previous []spec.Item
	text     string
}

func (f *fakeExtractor) Extract(_ context.Context, _ uuid.UUID, text string, previous []spec.Item) ([]spec.Item, error) {
	f.text, f.previous = text, previous
	return f.out, f.err
}

func setup(t *testing.T, ex spec.Extractor) (h *testutil.Harness, owner, pid string) {
	t.Helper()
	h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		project.Register(mux, mw, pool)
		spec.Register(mux, mw, pool, ex)
	})
	owner = h.Login("o@x.com", "owner")
	var p struct {
		ID string `json:"id"`
	}
	h.JSON(h.Do("POST", "/api/v1/projects", owner, map[string]string{"name": "Portal"}), &p)
	return h, owner, p.ID
}

type ingestResp struct {
	Spec struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
	} `json:"spec"`
	Requirements []spec.Item `json:"requirements"`
	Removed      []spec.Item `json:"removed"`
}

func TestIngest_VersionsAndDiff(t *testing.T) {
	ex := &fakeExtractor{out: []spec.Item{
		{Key: "REQ-001", Text: "Login", Criticality: "critical"},
		{Key: "REQ-002", Text: "Export", Criticality: "normal"},
	}}
	h, owner, pid := setup(t, ex)
	path := "/api/v1/projects/" + pid + "/specs"

	rec := h.Do("POST", path, owner, map[string]string{"title": "v1", "source_type": "text", "text": "The user logs in. Export."})
	if rec.Code != http.StatusCreated {
		t.Fatalf("ingest 1 = %d %s", rec.Code, rec.Body)
	}
	var v1 ingestResp
	h.JSON(rec, &v1)
	if v1.Spec.Version != 1 || len(v1.Requirements) != 2 || v1.Requirements[0].Status != "new" {
		t.Fatalf("v1 = %+v", v1)
	}
	if ex.text != "The user logs in. Export." || len(ex.previous) != 0 {
		t.Errorf("extractor input text=%q previous=%v", ex.text, ex.previous)
	}

	ex.out = []spec.Item{
		{Key: "REQ-001", Text: "Login", Criticality: "critical"},
		{Key: "REQ-002", Text: "Export CSV", Criticality: "normal"},
		{Key: "REQ-003", Text: "Audit", Criticality: "high"},
	}
	var v2 ingestResp
	h.JSON(h.Do("POST", path, owner, map[string]string{"title": "v2", "source_type": "text", "text": "v2 text"}), &v2)
	if v2.Spec.Version != 2 {
		t.Fatalf("version = %d", v2.Spec.Version)
	}
	if len(ex.previous) != 2 {
		t.Errorf("extractor must receive previous requirements, got %v", ex.previous)
	}
	status := map[string]string{}
	for _, r := range v2.Requirements {
		status[r.Key] = r.Status
	}
	if status["REQ-001"] != "unchanged" || status["REQ-002"] != "changed" || status["REQ-003"] != "new" {
		t.Errorf("statuses = %v", status)
	}

	var stored []spec.Item
	h.JSON(h.Do("GET", "/api/v1/specs/"+v2.Spec.ID+"/requirements", owner, nil), &stored)
	if len(stored) != 3 {
		t.Errorf("stored requirements = %+v", stored)
	}
	var list []struct {
		Version int `json:"version"`
	}
	h.JSON(h.Do("GET", path, owner, nil), &list)
	if len(list) != 2 || list[0].Version != 2 {
		t.Errorf("list = %+v", list)
	}

	ex.out = []spec.Item{{Key: "REQ-001", Text: "Login", Criticality: "critical"}}
	var v3 ingestResp
	h.JSON(h.Do("POST", path, owner, map[string]string{"title": "v3", "source_type": "text", "text": "v3"}), &v3)
	if len(v3.Removed) != 2 {
		t.Errorf("removed = %+v", v3.Removed)
	}
}

func TestIngest_ExtractorFailureStoresNothing(t *testing.T) {
	ex := &fakeExtractor{err: errors.New("llm down")}
	h, owner, pid := setup(t, ex)
	path := "/api/v1/projects/" + pid + "/specs"
	if c := h.Do("POST", path, owner, map[string]string{"title": "v1", "source_type": "text", "text": "x"}).Code; c != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", c)
	}
	var list []struct{}
	h.JSON(h.Do("GET", path, owner, nil), &list)
	if len(list) != 0 {
		t.Errorf("spec stored despite failure: %v", list)
	}
}

func TestIngest_ValidationAndAuthz(t *testing.T) {
	ex := &fakeExtractor{out: []spec.Item{{Key: "REQ-1", Text: "a", Criticality: "normal"}}}
	h, owner, pid := setup(t, ex)
	path := "/api/v1/projects/" + pid + "/specs"
	bad := []map[string]string{
		{"title": "", "source_type": "text", "text": "x"},
		{"title": "t", "source_type": "text", "text": "  "},
		{"title": "t", "source_type": "document", "text": "x"},
		{"title": "t", "source_type": "openapi", "text": "x"},
		{"title": "t", "source_type": "bogus", "text": "x"},
	}
	for i, b := range bad {
		if c := h.Do("POST", path, owner, b).Code; c != http.StatusBadRequest {
			t.Errorf("case %d = %d, want 400", i, c)
		}
	}
	ok := map[string]string{"title": "t", "source_type": "text", "text": "x"}
	viewer := h.Login("v@x.com", "viewer")
	if c := h.Do("POST", path, viewer, ok).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
	missing := "/api/v1/projects/00000000-0000-0000-0000-000000000000/specs"
	if c := h.Do("POST", missing, owner, ok).Code; c != http.StatusNotFound {
		t.Errorf("unknown project = %d, want 404", c)
	}
}

func TestIngest_WithoutLLMConfigured(t *testing.T) {
	h, owner, pid := setup(t, nil)
	c := h.Do("POST", "/api/v1/projects/"+pid+"/specs", owner, map[string]string{"title": "t", "source_type": "text", "text": "x"}).Code
	if c != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", c)
	}
}
