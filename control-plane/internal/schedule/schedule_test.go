package schedule_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/schedule"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

type fx struct {
	h     *testutil.Harness
	w     *testutil.World
	owner string
}

func setup(t *testing.T) *fx {
	t.Helper()
	f := &fx{}
	f.h = testutil.NewHarness(t, func(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
		schedule.Register(mux, mw, pool)
	})
	f.owner = f.h.Login("o@x.com", "owner")
	f.w = f.h.SeedWorld()
	return f
}

type schedView struct {
	ID        string  `json:"id"`
	RunType   string  `json:"run_type"`
	Cron      string  `json:"cron"`
	Enabled   bool    `json:"enabled"`
	NextRunAt string  `json:"next_run_at"`
	LastRunAt *string `json:"last_run_at"`
}

func (f *fx) create(runType, cron string) (int, schedView) {
	f.h.T.Helper()
	rec := f.h.Do("POST", "/api/v1/environments/"+f.w.EnvID.String()+"/schedules", f.owner, map[string]any{"run_type": runType, "cron": cron})
	var v schedView
	if rec.Code == http.StatusCreated {
		f.h.JSON(rec, &v)
	}
	return rec.Code, v
}

func TestAPI_CreateListToggleDelete(t *testing.T) {
	f := setup(t)
	code, s := f.create("exploration", "0 2 * * *") // nightly exploration (suggested default, CLAUDE.md 8.6)
	if code != http.StatusCreated || !s.Enabled || s.NextRunAt == "" {
		t.Fatalf("create = %d %+v", code, s)
	}
	if next, _ := time.Parse(time.RFC3339, s.NextRunAt); !next.After(time.Now()) || next.Hour() != 2 {
		t.Errorf("next_run_at = %s, want a future 02:00", s.NextRunAt)
	}
	var list []schedView
	f.h.JSON(f.h.Do("GET", "/api/v1/environments/"+f.w.EnvID.String()+"/schedules", f.owner, nil), &list)
	if len(list) != 1 || list[0].ID != s.ID {
		t.Fatalf("list = %+v", list)
	}

	var off schedView
	rec := f.h.Do("PATCH", "/api/v1/schedules/"+s.ID, f.owner, map[string]any{"enabled": false})
	if rec.Code != http.StatusOK {
		t.Fatalf("disable = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &off)
	if off.Enabled {
		t.Error("schedule still enabled")
	}
	if c := f.h.Do("DELETE", "/api/v1/schedules/"+s.ID, f.owner, nil).Code; c != http.StatusNoContent {
		t.Errorf("delete = %d", c)
	}
	if c := f.h.Do("DELETE", "/api/v1/schedules/"+s.ID, f.owner, nil).Code; c != http.StatusNotFound {
		t.Errorf("delete twice = %d, want 404", c)
	}
}

func TestAPI_Validation(t *testing.T) {
	f := setup(t)
	for name, body := range map[string]struct{ typ, cron string }{
		"bad type":        {"chaos", "0 2 * * *"},
		"bad cron":        {"exploration", "every night"},
		"empty cron":      {"exploration", ""},
		"too frequent":    {"exploration", "* * * * *"},
		"every 2 minutes": {"regression", "*/2 * * * *"},
	} {
		if code, _ := f.create(body.typ, body.cron); code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", name, code)
		}
	}
	if code, _ := f.create("regression", "@daily"); code != http.StatusCreated {
		t.Errorf("@daily = %d, want 201", code)
	}
	if c := f.h.Do("POST", "/api/v1/environments/"+uuid.NewString()+"/schedules", f.owner, map[string]any{"run_type": "exploration", "cron": "0 2 * * *"}).Code; c != http.StatusNotFound {
		t.Errorf("unknown env = %d, want 404", c)
	}
	viewer := f.h.Login("v@x.com", "viewer")
	if c := f.h.Do("POST", "/api/v1/environments/"+f.w.EnvID.String()+"/schedules", viewer, map[string]any{"run_type": "exploration", "cron": "0 2 * * *"}).Code; c != http.StatusForbidden {
		t.Errorf("viewer = %d, want 403", c)
	}
}

// due backdates a schedule so the next Tick picks it up.
func (f *fx) due(id string) {
	f.h.T.Helper()
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`, id); err != nil {
		f.h.T.Fatal(err)
	}
}

func (f *fx) runs(trigger string) int {
	f.h.T.Helper()
	var n int
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT count(*) FROM runs WHERE trigger = $1`, trigger).Scan(&n); err != nil {
		f.h.T.Fatal(err)
	}
	return n
}

func TestTick_CreatesTheRunThroughTheSameDomainFunctionAndAdvances(t *testing.T) {
	f := setup(t)
	_, s := f.create("exploration", "0 2 * * *")
	f.due(s.ID)

	now := time.Now()
	res, err := schedule.Tick(context.Background(), f.h.Pool, now)
	if err != nil || res.Created != 1 {
		t.Fatalf("tick = %+v, %v", res, err)
	}
	if f.runs("schedule") != 1 {
		t.Fatal("expected one run with trigger=schedule")
	}
	var actor string
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT actor FROM audit_log WHERE action = 'run.create' ORDER BY at DESC LIMIT 1`).Scan(&actor); err != nil || actor != "scheduler" {
		t.Errorf("audit actor = %q (%v), want scheduler", actor, err)
	}
	var next time.Time
	var last *time.Time
	if err := f.h.Pool.QueryRow(context.Background(), `SELECT next_run_at, last_run_at FROM schedules WHERE id = $1`, s.ID).Scan(&next, &last); err != nil {
		t.Fatal(err)
	}
	if !next.After(now) || last == nil {
		t.Errorf("next=%s last=%v: must advance into the future and record the run", next, last)
	}

	// nothing is due any more: no duplicate
	if res, _ := schedule.Tick(context.Background(), f.h.Pool, now); res.Created != 0 {
		t.Errorf("second tick created %d", res.Created)
	}
}

func TestTick_SkipsAndStillAdvancesWhenThereIsNothingToDo(t *testing.T) {
	f := setup(t)
	ctx := context.Background()

	// 1) an exploration is already queued for the environment: do not stack another one
	_, s1 := f.create("exploration", "0 2 * * *")
	f.w.NewRun("exploration", time.Now(), time.Second)
	if _, err := f.h.Pool.Exec(ctx, `UPDATE runs SET status = 'queued', finished_at = NULL`); err != nil {
		t.Fatal(err)
	}
	f.due(s1.ID)
	res, err := schedule.Tick(ctx, f.h.Pool, time.Now())
	if err != nil || res.Created != 0 || res.Skipped != 1 {
		t.Fatalf("active run: %+v, %v", res, err)
	}
	var advanced bool
	_ = f.h.Pool.QueryRow(ctx, `SELECT next_run_at > now() FROM schedules WHERE id = $1`, s1.ID).Scan(&advanced)
	if !advanced {
		t.Error("a skipped schedule must still move to its next slot")
	}

	// 2) production environments never run
	var prodEnv uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `INSERT INTO environments (organization_id, project_id, name, base_url, allowed_hosts, is_production) VALUES ($1, $2, 'prod', 'https://p.com', '{p.com}', true) RETURNING id`, f.h.OrgID, f.w.ProjectID).Scan(&prodEnv)
	var prodSched uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `INSERT INTO schedules (organization_id, project_id, environment_id, run_type, cron, next_run_at) VALUES ($1, $2, $3, 'exploration', '0 2 * * *', now() - interval '1 minute') RETURNING id`, f.h.OrgID, f.w.ProjectID, prodEnv).Scan(&prodSched)
	before := f.runs("schedule")
	res, _ = schedule.Tick(ctx, f.h.Pool, time.Now())
	if res.Created != 0 || f.runs("schedule") != before {
		t.Errorf("production schedule created a run: %+v", res)
	}

	// 3) regression with nothing covered is skipped, not an error
	var bareEnv uuid.UUID
	_ = f.h.Pool.QueryRow(ctx, `INSERT INTO environments (organization_id, project_id, name, base_url, allowed_hosts) VALUES ($1, $2, 'bare', 'https://b.com', '{b.com}') RETURNING id`, f.h.OrgID, f.w.ProjectID).Scan(&bareEnv)
	_, _ = f.h.Pool.Exec(ctx, `INSERT INTO schedules (organization_id, project_id, environment_id, run_type, cron, next_run_at) VALUES ($1, $2, $3, 'regression', '0 2 * * *', now() - interval '1 minute')`, f.h.OrgID, f.w.ProjectID, bareEnv)
	if res, err := schedule.Tick(ctx, f.h.Pool, time.Now()); err != nil || res.Created != 0 || res.Skipped != 1 {
		t.Errorf("regression without coverage: %+v, %v", res, err)
	}
}

func TestTick_DisabledSchedulesAreIgnored(t *testing.T) {
	f := setup(t)
	_, s := f.create("exploration", "0 2 * * *")
	f.h.Do("PATCH", "/api/v1/schedules/"+s.ID, f.owner, map[string]any{"enabled": false})
	f.due(s.ID)
	if res, _ := schedule.Tick(context.Background(), f.h.Pool, time.Now()); res.Created != 0 {
		t.Errorf("disabled schedule created %d runs", res.Created)
	}
}

func TestTick_ConcurrentInstancesCreateExactlyOneRun(t *testing.T) {
	f := setup(t)
	_, s := f.create("exploration", "0 2 * * *")
	f.due(s.ID)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = schedule.Tick(context.Background(), f.h.Pool, time.Now())
		}()
	}
	wg.Wait()
	if n := f.runs("schedule"); n != 1 {
		t.Errorf("runs created by 4 concurrent ticks = %d, want 1", n)
	}
}

func TestTick_AFarOverdueScheduleRunsOnceInsteadOfCatchingUp(t *testing.T) {
	f := setup(t)
	_, s := f.create("exploration", "0 2 * * *")
	if _, err := f.h.Pool.Exec(context.Background(), `UPDATE schedules SET next_run_at = now() - interval '10 days' WHERE id = $1`, s.ID); err != nil {
		t.Fatal(err)
	}
	res, _ := schedule.Tick(context.Background(), f.h.Pool, time.Now())
	if res.Created != 1 {
		t.Errorf("created = %d, want exactly 1 after a long outage", res.Created)
	}
	if res, _ := schedule.Tick(context.Background(), f.h.Pool, time.Now()); res.Created != 0 {
		t.Error("must not catch up the missed days")
	}
}
