package runnerapi_test

import (
	"context"
	"net/http"
	"testing"
)

// explored runs and completes an exploration that mapped the given screens (label -> user).
func (f *fx) explored(screens map[string]string) {
	f.h.T.Helper()
	f.newRun()
	j, _ := f.lease(f.runner)
	seq := 1
	for label, user := range screens {
		if c := f.events(f.runner, j.RunID, ev(seq, "node_discovered", map[string]any{"fingerprint": "fp-" + user + label, "kind": "page", "label": label, "app_role": user, "metadata": map[string]any{"url": "https://a.com" + label}})); c != http.StatusOK {
			f.h.T.Fatalf("events = %d", c)
		}
		seq++
	}
	f.finish(f.runner, j.RunID, "succeeded", map[string]any{"pages": len(screens)})
}

func (f *fx) count(q string, args ...any) int {
	f.h.T.Helper()
	var n int
	if err := f.h.Pool.QueryRow(context.Background(), q, args...).Scan(&n); err != nil {
		f.h.T.Fatal(err)
	}
	return n
}

// An exploration that could not do anything (the application was down, nobody could log in) must not leave an empty map as
// the latest: the map that was there is still the right one.
func TestComplete_ABlockedExplorationThatMappedNothingLeavesThePreviousMapAsTheLatest(t *testing.T) {
	f := setup(t)
	f.explored(map[string]string{"/orders": "admin", "/customers": "admin"})
	var before string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT id::text FROM graphs ORDER BY version DESC LIMIT 1`).Scan(&before); err != nil {
		t.Fatal(err)
	}

	f.newRun()
	j, _ := f.lease(f.runner)
	f.finish(f.runner, j.RunID, "failed", map[string]any{
		"pages": 0, "error": "A aplicação não respondeu",
		"blocked": map[string]any{"kind": "app_down", "message": "A aplicação não respondeu"},
	})

	var latest string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT id::text FROM graphs ORDER BY version DESC LIMIT 1`).Scan(&latest); err != nil {
		t.Fatal(err)
	}
	if latest != before {
		t.Errorf("latest graph = %s, want the previous one %s: a run that mapped nothing must not leave an empty map in its place", latest, before)
	}
	if n := f.count(`SELECT count(*) FROM nodes WHERE graph_id = $1`, before); n != 2 {
		t.Errorf("previous graph has %d nodes, want it untouched (2)", n)
	}
	if n := f.count(`SELECT count(*) FROM runs WHERE id = $1 AND graph_id IS NULL AND status = 'failed'`, j.RunID); n != 1 {
		t.Error("the blocked run should be kept (failed, with the reason), pointing at no graph")
	}
	if n := f.count(`SELECT count(*) FROM graphs`); n != 1 {
		t.Errorf("graphs = %d, want only the first", n)
	}
}

func TestComplete_AFailedRunWithoutABlockKeepsItsGraph(t *testing.T) {
	f := setup(t)
	f.explored(map[string]string{"/orders": "admin"})
	f.newRun()
	j, _ := f.lease(f.runner)
	f.finish(f.runner, j.RunID, "failed", map[string]any{"error": "runner crashed"})
	if n := f.count(`SELECT count(*) FROM graphs`); n != 2 {
		t.Errorf("graphs = %d, want both: only a run that was blocked before mapping anything gives its graph up", n)
	}
}

func TestComplete_AResumedExplorationThatIsBlockedKeepsTheGraphItWorksOn(t *testing.T) {
	f := setup(t)
	f.explored(map[string]string{"/orders": "admin"})
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE runs SET status = 'cancelled' WHERE environment_id = $1`, f.envID); err != nil {
		t.Fatal(err)
	}
	if c := f.h.Do("POST", "/api/v1/environments/"+f.envID+"/runs", f.owner, map[string]any{"type": "exploration", "budget": map[string]any{"resume": true}}).Code; c != http.StatusCreated {
		t.Fatalf("resume = %d", c)
	}
	j := f.leaseResume(f.runner)
	f.finish(f.runner, j.RunID, "failed", map[string]any{"pages": 0, "blocked": map[string]any{"kind": "app_down", "message": "x"}})
	if n := f.count(`SELECT count(*) FROM nodes`); n != 1 {
		t.Errorf("nodes = %d, want the map the resume works on kept", n)
	}
}

// Users who could not get in this time keep the map they had: otherwise a wrong password would erase their screens.
func TestComplete_UsersWhoCouldNotLogInKeepTheirPreviousMap(t *testing.T) {
	f := setup(t)
	f.explored(map[string]string{"/orders": "admin", "/reports": "operador"})

	f.newRun()
	j, _ := f.lease(f.runner)
	f.events(f.runner, j.RunID, ev(1, "node_discovered", map[string]any{"fingerprint": "fp-admin/orders", "kind": "page", "label": "/orders", "app_role": "admin", "metadata": map[string]any{"url": "https://a.com/orders"}}))
	f.finish(f.runner, j.RunID, "succeeded", map[string]any{
		"pages": 1, "login_failures": []string{"operador"},
		"blocked": map[string]any{"kind": "login_failed", "roles": []string{"operador"}, "message": "Não foi possível entrar como operador"},
	})

	var latest string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT id::text FROM graphs ORDER BY version DESC LIMIT 1`).Scan(&latest); err != nil {
		t.Fatal(err)
	}
	if n := f.count(`SELECT count(*) FROM nodes WHERE graph_id = $1 AND 'operador' = ANY(app_roles)`, latest); n != 1 {
		t.Errorf("operador screens in the new map = %d, want the 1 they had (the login failed, so nothing new was learned)", n)
	}
	if n := f.count(`SELECT count(*) FROM nodes WHERE graph_id = $1 AND 'admin' = ANY(app_roles)`, latest); n != 1 {
		t.Errorf("admin screens = %d, want the 1 just explored", n)
	}
}
