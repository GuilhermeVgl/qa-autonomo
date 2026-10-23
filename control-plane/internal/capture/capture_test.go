package capture_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/capture"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/runnerapi"
	"github.com/kpmg/agent-qa/control-plane/internal/secret"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fx struct {
	h      *testutil.Harness
	owner  string
	envID  string
	runner string
}

func setup(t *testing.T) *fx {
	t.Helper()
	box, err := secret.New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	var hub *capture.Hub
	f := &fx{}
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		project.Register(mux, mw, pool)
		environment.Register(mux, mw, pool, box)
		hub = capture.NewHub(pool, box)
		capture.Register(mux, mw, pool, hub)
	})
	runnerapi.Register(f.h.Mux, f.h.Pool, runnerapi.Deps{Box: box, Capture: hub, BootstrapToken: "boot", OrganizationID: f.h.OrgID})
	f.owner = f.h.Login("o@x.com", "owner")

	var p struct{ ID string }
	f.h.JSON(f.h.Do("POST", "/api/v1/projects", f.owner, map[string]string{"name": "P"}), &p)
	var e struct{ ID string }
	f.h.JSON(f.h.Do("POST", "/api/v1/projects/"+p.ID+"/environments", f.owner, map[string]any{"name": "hml", "base_url": "https://a.com"}), &e)
	f.envID = e.ID

	rec := f.h.Do("POST", "/runner/v1/register", "", map[string]any{"bootstrap_token": "boot", "name": "r1", "labels": []string{}, "version": "0"})
	var reg struct {
		Token string `json:"token"`
	}
	f.h.JSON(rec, &reg)
	f.runner = reg.Token
	return f
}

func TestCapture_EndToEndStoresSessionCredential(t *testing.T) {
	f := setup(t)

	// UI starts a capture; the runner leases it.
	var c struct {
		ID       string `json:"id"`
		StartURL string `json:"start_url"`
	}
	if rec := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/capture", f.owner, map[string]any{"app_role": "admin"}); rec.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", rec.Code, rec.Body)
	} else {
		f.h.JSON(rec, &c)
	}
	if c.StartURL != "https://a.com" {
		t.Errorf("start_url = %q", c.StartURL)
	}
	var leased struct {
		ID      string `json:"id"`
		Status  string `json:"status"`
		AppRole string `json:"app_role"`
	}
	rec := f.h.Do("POST", "/runner/v1/capture/lease?wait=2000", f.runner, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("lease = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &leased)
	if leased.ID != c.ID || leased.Status != "active" || leased.AppRole != "admin" {
		t.Fatalf("leased = %+v", leased)
	}

	// UI input reaches the runner's poll.
	if code := f.h.Do("POST", "/api/v1/capture/"+c.ID+"/input", f.owner, map[string]any{"events": []map[string]any{{"type": "click", "x": 0.5, "y": 0.4}}}).Code; code != http.StatusNoContent {
		t.Fatalf("input = %d", code)
	}
	var poll struct {
		Events []map[string]any `json:"events"`
		Finish bool             `json:"finish"`
	}
	f.h.JSON(f.h.Do("POST", "/runner/v1/capture/"+c.ID+"/poll?wait=2000", f.runner, nil), &poll)
	if len(poll.Events) != 1 || poll.Events[0]["type"] != "click" {
		t.Fatalf("poll = %+v", poll)
	}

	// UI finishes; the runner sees it and uploads the captured session.
	if code := f.h.Do("POST", "/api/v1/capture/"+c.ID+"/finish", f.owner, nil).Code; code != http.StatusNoContent {
		t.Fatalf("finish = %d", code)
	}
	f.h.JSON(f.h.Do("POST", "/runner/v1/capture/"+c.ID+"/poll?wait=2000", f.runner, nil), &poll)
	if !poll.Finish {
		t.Fatal("runner did not see finish")
	}
	state := `{"cookies":[{"name":"sid","value":"s3cr3t"}],"origins":[]}`
	if code := f.h.Do("POST", "/runner/v1/capture/"+c.ID+"/result", f.runner, map[string]any{"state": state}).Code; code != http.StatusNoContent {
		t.Fatalf("result = %d", code)
	}

	// a session credential is now stored, encrypted, for the env/role.
	var kind string
	var raw []byte
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT kind, payload_encrypted FROM credentials WHERE environment_id=$1 AND app_role='admin'`, f.envID).Scan(&kind, &raw); err != nil {
		t.Fatal(err)
	}
	if kind != "session" || bytes.Contains(raw, []byte("s3cr3t")) {
		t.Errorf("kind=%q plaintext=%v", kind, bytes.Contains(raw, []byte("s3cr3t")))
	}

	// and the UI sees it done.
	var st struct {
		Status string `json:"status"`
	}
	f.h.JSON(f.h.Do("GET", "/api/v1/capture/"+c.ID, f.owner, nil), &st)
	if st.Status != "done" {
		t.Errorf("status = %q, want done", st.Status)
	}
}

func TestCapture_Validation(t *testing.T) {
	f := setup(t)
	// app_role is required
	if code := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/capture", f.owner, map[string]any{}).Code; code != http.StatusBadRequest {
		t.Errorf("missing app_role = %d, want 400", code)
	}
	// an unknown session is 404 on every route
	if code := f.h.Do("GET", "/api/v1/capture/"+uuid.NewString(), f.owner, nil).Code; code != http.StatusNotFound {
		t.Errorf("unknown status = %d, want 404", code)
	}
	if code := f.h.Do("POST", "/api/v1/capture/"+uuid.NewString()+"/finish", f.owner, nil).Code; code != http.StatusNotFound {
		t.Errorf("unknown finish = %d, want 404", code)
	}
	// a viewer cannot start a capture
	viewer := f.h.Login("v@x.com", "viewer")
	if code := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/capture", viewer, map[string]any{"app_role": "admin"}).Code; code != http.StatusForbidden {
		t.Errorf("viewer capture = %d, want 403", code)
	}
}
