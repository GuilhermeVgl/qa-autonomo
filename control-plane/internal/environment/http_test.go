package environment_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/secret"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

func setup(t *testing.T) (h *testutil.Harness, owner, projectID string) {
	t.Helper()
	box, err := secret.New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		project.Register(mux, mw, pool)
		environment.Register(mux, mw, pool, box)
	})
	owner = h.Login("o@x.com", "owner")
	var p struct {
		ID string `json:"id"`
	}
	h.JSON(h.Do("POST", "/api/v1/projects", owner, map[string]string{"name": "Portal"}), &p)
	return h, owner, p.ID
}

type env struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	BaseURL           string   `json:"base_url"`
	AllowedHosts      []string `json:"allowed_hosts"`
	DestructivePolicy string   `json:"destructive_policy"`
	IsProduction      bool     `json:"is_production"`
	Device            *string  `json:"device"`
	Kind              string   `json:"kind"`
	Binary            *string  `json:"binary"`
	Image             *string  `json:"image"`
}

func TestEnvironment_DefaultsAndList(t *testing.T) {
	h, owner, pid := setup(t)
	rec := h.Do("POST", "/api/v1/projects/"+pid+"/environments", owner,
		map[string]any{"name": "hml", "base_url": "https://hml.example.com:8443/app"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var e env
	h.JSON(rec, &e)
	if len(e.AllowedHosts) != 1 || e.AllowedHosts[0] != "hml.example.com" {
		t.Errorf("allowed_hosts default = %v", e.AllowedHosts)
	}
	if e.DestructivePolicy != "block" || e.IsProduction {
		t.Errorf("defaults = %+v", e)
	}
	var list []env
	h.JSON(h.Do("GET", "/api/v1/projects/"+pid+"/environments", owner, nil), &list)
	if len(list) != 1 {
		t.Fatalf("list = %+v", list)
	}
}

func TestEnvironment_Validation(t *testing.T) {
	h, owner, pid := setup(t)
	path := "/api/v1/projects/" + pid + "/environments"
	bad := []map[string]any{
		{"name": "", "base_url": "https://a.com"},
		{"name": "x", "base_url": "ftp://a.com"},
		{"name": "x", "base_url": "not a url"},
		{"name": "x", "base_url": "https://a.com", "destructive_policy": "yolo"},
		{"name": "x", "base_url": "https://a.com", "allowed_hosts": []string{""}},
	}
	for i, b := range bad {
		if c := h.Do("POST", path, owner, b).Code; c != http.StatusBadRequest {
			t.Errorf("case %d = %d, want 400", i, c)
		}
	}
	missing := "/api/v1/projects/00000000-0000-0000-0000-000000000000/environments"
	if c := h.Do("POST", missing, owner, map[string]any{"name": "x", "base_url": "https://a.com"}).Code; c != http.StatusNotFound {
		t.Errorf("unknown project = %d, want 404", c)
	}
	viewer := h.Login("v@x.com", "viewer")
	if c := h.Do("POST", path, viewer, map[string]any{"name": "x", "base_url": "https://a.com"}).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
}

func TestCredentials_EncryptedMaskedAndAudited(t *testing.T) {
	h, owner, pid := setup(t)
	var e env
	h.JSON(h.Do("POST", "/api/v1/projects/"+pid+"/environments", owner,
		map[string]any{"name": "hml", "base_url": "https://hml.example.com"}), &e)
	path := "/api/v1/environments/" + e.ID + "/credentials"

	body := map[string]any{"app_role": "admin", "kind": "login", "payload": map[string]string{"username": "adm", "password": "S3cr3t!"}}
	rec := h.Do("PUT", path, owner, body)
	if rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	if bytes.Contains(rec.Body.Bytes(), []byte("S3cr3t")) {
		t.Error("response leaks secret")
	}
	// updating the same role/kind replaces instead of duplicating
	body["payload"] = map[string]string{"username": "adm", "password": "N3w!"}
	if c := h.Do("PUT", path, owner, body).Code; c != http.StatusOK {
		t.Fatalf("put again = %d", c)
	}

	list := h.Do("GET", path, owner, nil)
	if bytes.Contains(list.Body.Bytes(), []byte("N3w")) || bytes.Contains(list.Body.Bytes(), []byte("password")) {
		t.Error("list leaks secret")
	}
	var creds []struct {
		AppRole string `json:"app_role"`
		Kind    string `json:"kind"`
	}
	h.JSON(list, &creds)
	if len(creds) != 1 || creds[0].AppRole != "admin" || creds[0].Kind != "login" {
		t.Errorf("creds = %+v", creds)
	}

	var raw []byte
	if err := h.Pool.QueryRow(context.Background(), `SELECT payload_encrypted FROM credentials`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("N3w")) {
		t.Error("credential stored in plaintext")
	}

	entries, err := audit.New(h.Pool).ListAudit(context.Background(), audit.ListAuditParams{OrganizationID: h.OrgID, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	for _, en := range entries {
		if en.Action == "credential.upsert" {
			n++
			if bytes.Contains(en.Payload, []byte("N3w")) || bytes.Contains(en.Payload, []byte("S3cr3t")) {
				t.Error("audit payload leaks secret")
			}
		}
	}
	if n != 2 {
		t.Errorf("credential.upsert audit entries = %d, want 2", n)
	}
}

func TestCredentials_Validation(t *testing.T) {
	h, owner, pid := setup(t)
	var e env
	h.JSON(h.Do("POST", "/api/v1/projects/"+pid+"/environments", owner,
		map[string]any{"name": "hml", "base_url": "https://hml.example.com"}), &e)
	path := "/api/v1/environments/" + e.ID + "/credentials"
	bad := []map[string]any{
		{"app_role": "", "kind": "login", "payload": map[string]string{"username": "a", "password": "b"}},
		{"app_role": "admin", "kind": "oauth", "payload": map[string]string{"x": "y"}},
		{"app_role": "admin", "kind": "login", "payload": map[string]string{"username": "a"}},
		{"app_role": "admin", "kind": "api_token", "payload": map[string]string{"username": "a"}},
	}
	for i, b := range bad {
		if c := h.Do("PUT", path, owner, b).Code; c != http.StatusBadRequest {
			t.Errorf("case %d = %d, want 400", i, c)
		}
	}
	viewer := h.Login("v@x.com", "viewer")
	ok := map[string]any{"app_role": "a", "kind": "api_token", "payload": map[string]string{"token": "t"}}
	if c := h.Do("PUT", path, viewer, ok).Code; c != http.StatusForbidden {
		t.Errorf("viewer put = %d, want 403", c)
	}
}

func TestEnvironment_MobileDevice(t *testing.T) {
	h, owner, pid := setup(t)
	path := "/api/v1/projects/" + pid + "/environments"

	rec := h.Do("POST", path, owner, map[string]any{"name": "hml-mobile", "base_url": "https://hml.example.com", "device": "iPhone 13"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var e env
	h.JSON(rec, &e)
	if e.Device == nil || *e.Device != "iPhone 13" {
		t.Errorf("device = %v", e.Device)
	}

	// desktop environments have no device
	var d env
	h.JSON(h.Do("POST", path, owner, map[string]any{"name": "hml", "base_url": "https://hml.example.com"}), &d)
	if d.Device != nil {
		t.Errorf("desktop environment device = %v, want null", *d.Device)
	}

	for name, device := range map[string]string{"unknown device": "Nokia 3310", "blank": "  "} {
		if c := h.Do("POST", path, owner, map[string]any{"name": "x-" + name, "base_url": "https://a.com", "device": device}).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}

	var list []env
	h.JSON(h.Do("GET", path, owner, nil), &list)
	if len(list) != 2 {
		t.Fatalf("list = %+v", list)
	}
}

func TestEnvironment_Terminal(t *testing.T) {
	h, owner, pid := setup(t)
	path := "/api/v1/projects/" + pid + "/environments"

	rec := h.Do("POST", path, owner, map[string]any{"name": "cli", "kind": "terminal", "binary": "samplecli", "image": "registry.local/samplecli:1.2"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	}
	var e env
	h.JSON(rec, &e)
	if e.Kind != "terminal" || e.Binary == nil || *e.Binary != "samplecli" || e.Image == nil || *e.Image != "registry.local/samplecli:1.2" {
		t.Errorf("env = %+v", e)
	}
	if e.BaseURL != "terminal://samplecli" || len(e.AllowedHosts) != 0 || e.DestructivePolicy != "block" {
		t.Errorf("terminal environment has no URL or hosts and blocks destructive actions by default: %+v", e)
	}

	// the image is optional; web environments stay web
	var plain env
	h.JSON(h.Do("POST", path, owner, map[string]any{"name": "cli2", "kind": "terminal", "binary": "tool"}), &plain)
	if plain.Image != nil {
		t.Errorf("image = %v, want null", *plain.Image)
	}
	var web env
	h.JSON(h.Do("POST", path, owner, map[string]any{"name": "hml", "base_url": "https://a.com"}), &web)
	if web.Kind != "web" || web.Binary != nil {
		t.Errorf("web env = %+v", web)
	}

	bad := map[string]map[string]any{
		"missing binary":     {"name": "x1", "kind": "terminal"},
		"binary with space":  {"name": "x2", "kind": "terminal", "binary": "rm -rf /"},
		"binary with shell":  {"name": "x3", "kind": "terminal", "binary": "tool;id"},
		"binary like a flag": {"name": "x4", "kind": "terminal", "binary": "--help"},
		"bad image":          {"name": "x5", "kind": "terminal", "binary": "tool", "image": "a b; c"},
		"device on terminal": {"name": "x6", "kind": "terminal", "binary": "tool", "device": "iPhone 13"},
		"binary on web":      {"name": "x7", "base_url": "https://a.com", "binary": "tool"},
		"unknown kind":       {"name": "x8", "kind": "mainframe", "base_url": "https://a.com"},
	}
	for name, body := range bad {
		if c := h.Do("POST", path, owner, body).Code; c != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, c)
		}
	}
}
