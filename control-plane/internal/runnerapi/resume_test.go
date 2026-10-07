package runnerapi_test

import (
	"net/http"
	"testing"
)

type resumeJob struct {
	RunID       string `json:"run_id"`
	Credentials []struct {
		AppRole string `json:"app_role"`
	} `json:"credentials"`
	Resume *struct {
		Generation int `json:"generation"`
		Known      []struct {
			Fingerprint string           `json:"fingerprint"`
			AppRole     string           `json:"app_role"`
			Followed    []map[string]any `json:"followed"`
		} `json:"known"`
	} `json:"resume"`
}

func (f *fx) leaseResume(token string) resumeJob {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/runner/v1/jobs/lease?wait=0", token, nil)
	if rec.Code != http.StatusOK {
		f.h.T.Fatalf("lease = %d %s", rec.Code, rec.Body)
	}
	var j resumeJob
	f.h.JSON(rec, &j)
	return j
}

func (f *fx) startRun(budget map[string]any) string {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "exploration", "budget": budget})
	if rec.Code != http.StatusCreated {
		f.h.T.Fatalf("create run = %d %s", rec.Code, rec.Body)
	}
	var r struct{ ID string }
	f.h.JSON(rec, &r)
	return r.ID
}

func (f *fx) finish(token, runID, status string, summary map[string]any) {
	f.h.T.Helper()
	if c := f.h.Do("POST", "/runner/v1/jobs/"+runID+"/complete", token, map[string]any{"status": status, "summary": summary}).Code; c != http.StatusOK {
		f.h.T.Fatalf("complete = %d", c)
	}
}

// Exploring some users hands the runner only their credentials: the others stay as they were mapped.
func TestLease_CompleteExplorationCarriesEveryUser(t *testing.T) {
	f := setup(t)
	f.h.Do("PUT", "/api/v1/environments/"+f.envID+"/credentials", f.owner,
		map[string]any{"app_role": "operador", "kind": "login", "payload": map[string]string{"username": "op", "password": "pw2"}})

	f.startRun(map[string]any{})
	if j := f.leaseResume(f.runner); len(j.Credentials) != 2 || j.Resume != nil {
		t.Fatalf("complete exploration: %d credentials, resume=%v; want both users and no resume", len(j.Credentials), j.Resume)
	}
}

func TestLease_PartialExplorationFiltersCredentials(t *testing.T) {
	f := setup(t)
	f.h.Do("PUT", "/api/v1/environments/"+f.envID+"/credentials", f.owner,
		map[string]any{"app_role": "operador", "kind": "login", "payload": map[string]string{"username": "op", "password": "pw2"}})
	f.startRun(map[string]any{"roles": []string{"operador"}})
	j := f.leaseResume(f.runner)
	if len(j.Credentials) != 1 || j.Credentials[0].AppRole != "operador" {
		t.Errorf("credentials = %+v, want only operador", j.Credentials)
	}
}

// A continued exploration tells the runner what is already known, so it does not examine those screens again.
func TestLease_ResumeCarriesWhatIsAlreadyKnown(t *testing.T) {
	f := setup(t)
	first := f.startRun(map[string]any{})
	j := f.leaseResume(f.runner)
	if j.RunID != first {
		t.Fatal("wrong run")
	}
	followed := []map[string]any{{"url": "https://a.com/search?q=x", "label": "Buscar", "type": "search", "intent": "search"}}
	if c := f.events(f.runner, first,
		ev(1, "node_discovered", map[string]any{"fingerprint": "fp-home", "kind": "page", "label": "/", "app_role": "admin", "metadata": map[string]any{"url": "https://a.com/", "followed": followed}}),
		ev(2, "node_discovered", map[string]any{"fingerprint": "fp-old", "kind": "page", "label": "/old", "app_role": "admin", "metadata": map[string]any{"url": "https://a.com/old"}}),
		ev(3, "node_discovered", map[string]any{"fingerprint": "POST /x", "kind": "endpoint", "label": "POST /x", "app_role": "admin", "metadata": map[string]any{}}),
	); c != http.StatusOK {
		t.Fatalf("events = %d", c)
	}
	f.finish(f.runner, first, "failed", map[string]any{"error": "boom"})

	f.startRun(map[string]any{"resume": true})
	r := f.leaseResume(f.runner)
	if r.Resume == nil {
		t.Fatal("a resumed job must carry the known screens")
	}
	if len(r.Resume.Known) != 2 {
		t.Fatalf("known = %+v, want the 2 page nodes (endpoints are not screens)", r.Resume.Known)
	}
	byFp := map[string]int{}
	for i, k := range r.Resume.Known {
		byFp[k.Fingerprint] = i
		if k.AppRole != "admin" {
			t.Errorf("known %s role = %q, want admin", k.Fingerprint, k.AppRole)
		}
	}
	home := r.Resume.Known[byFp["fp-home"]]
	if len(home.Followed) != 1 || home.Followed[0]["url"] != "https://a.com/search?q=x" || home.Followed[0]["type"] != "search" {
		t.Errorf("followed = %+v, want where the actions led", home.Followed)
	}
	if r.Resume.Generation != 1 {
		t.Errorf("generation = %d, want 1 (one exploration came before; it keeps the test data of this one different)", r.Resume.Generation)
	}
}
