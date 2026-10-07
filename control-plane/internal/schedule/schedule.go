// Package schedule runs exploration/regression on a cron (CLAUDE.md, seção 8.6). It is a small Postgres-backed
// scheduler: due rows are claimed with FOR UPDATE SKIP LOCKED, so several control-plane instances never double-fire.
package schedule

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/robfig/cron/v3"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
)

// minInterval keeps a typo from turning a schedule into a run flood.
const minInterval = 5 * time.Minute

func parse(expr string) (cron.Schedule, error) {
	s, err := cron.ParseStandard(expr)
	if err != nil {
		return nil, fmt.Errorf("invalid cron: %w", err)
	}
	first := s.Next(time.Now())
	if second := s.Next(first); second.Sub(first) < minInterval {
		return nil, fmt.Errorf("cron runs more often than every %s", minInterval)
	}
	return s, nil
}

type view struct {
	ID            uuid.UUID  `json:"id"`
	EnvironmentID uuid.UUID  `json:"environment_id"`
	RunType       string     `json:"run_type"`
	Cron          string     `json:"cron"`
	Enabled       bool       `json:"enabled"`
	NextRunAt     time.Time  `json:"next_run_at"`
	LastRunAt     *time.Time `json:"last_run_at"`
}

func toView(s Schedule) view {
	v := view{ID: s.ID, EnvironmentID: s.EnvironmentID, RunType: s.RunType, Cron: s.Cron, Enabled: s.Enabled, NextRunAt: s.NextRunAt.Time}
	if s.LastRunAt.Valid {
		v.LastRunAt = &s.LastRunAt.Time
	}
	return v
}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	q := New(pool)
	envs := environment.New(pool)
	write := func(h http.HandlerFunc) http.Handler { return mw(auth.RequireWriter(h)) }

	mux.Handle("POST /api/v1/environments/{id}/schedules", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			RunType string `json:"run_type"`
			Cron    string `json:"cron"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		if in.RunType != "exploration" && in.RunType != "regression" {
			httpx.Error(w, http.StatusBadRequest, "run_type must be exploration or regression")
			return
		}
		sched, err := parse(in.Cron)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		env, err := envs.GetEnvironment(r.Context(), environment.GetEnvironmentParams{OrganizationID: p.OrganizationID, ID: eid})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		row, err := q.CreateSchedule(r.Context(), CreateScheduleParams{
			OrganizationID: p.OrganizationID, ProjectID: env.ProjectID, EnvironmentID: env.ID, RunType: in.RunType, Cron: in.Cron, NextRunAt: ts(sched.Next(time.Now())),
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, toView(row))
	}))

	mux.Handle("GET /api/v1/environments/{id}/schedules", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListSchedules(r.Context(), ListSchedulesParams{OrganizationID: p.OrganizationID, EnvironmentID: eid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]view, 0, len(rows))
		for _, s := range rows {
			out = append(out, toView(s))
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("PATCH /api/v1/schedules/{id}", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Enabled bool `json:"enabled"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		cur, err := q.GetSchedule(r.Context(), GetScheduleParams{OrganizationID: p.OrganizationID, ID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		sched, err := parse(cur.Cron)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		// re-enabling must not fire immediately for slots missed while it was off
		row, err := q.SetScheduleEnabled(r.Context(), SetScheduleEnabledParams{OrganizationID: p.OrganizationID, ID: id, Enabled: in.Enabled, NextRunAt: ts(sched.Next(time.Now()))})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, toView(row))
	}))

	mux.Handle("DELETE /api/v1/schedules/{id}", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		n, err := q.DeleteSchedule(r.Context(), DeleteScheduleParams{OrganizationID: p.OrganizationID, ID: id})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if n == 0 {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
}

// TickResult says what one scheduler pass did.
type TickResult struct{ Created, Skipped int }

// Tick fires every due schedule once. A schedule always moves to its next slot, even when it was skipped
// (production, nothing to test, a run of that type already active), and an outage never causes a catch-up burst.
func Tick(ctx context.Context, pool *pgxpool.Pool, now time.Time) (TickResult, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return TickResult{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	q := New(tx)
	due, err := q.ClaimDueSchedules(ctx, ts(now))
	if err != nil {
		return TickResult{}, fmt.Errorf("claim due schedules: %w", err)
	}
	envs := environment.New(pool)
	var res TickResult
	for _, s := range due {
		created, err := fire(ctx, pool, q, envs, s)
		if err != nil {
			return TickResult{}, err
		}
		if created {
			res.Created++
		} else {
			res.Skipped++
		}
		sched, err := cron.ParseStandard(s.Cron)
		if err != nil {
			return TickResult{}, fmt.Errorf("stored cron %q: %w", s.Cron, err)
		}
		if err := q.AdvanceSchedule(ctx, AdvanceScheduleParams{ID: s.ID, LastRunAt: ts(now), NextRunAt: ts(sched.Next(now))}); err != nil {
			return TickResult{}, fmt.Errorf("advance schedule: %w", err)
		}
	}
	return res, tx.Commit(ctx)
}

func fire(ctx context.Context, pool *pgxpool.Pool, q *Queries, envs *environment.Queries, s Schedule) (bool, error) {
	env, err := envs.GetEnvironment(ctx, environment.GetEnvironmentParams{OrganizationID: s.OrganizationID, ID: s.EnvironmentID})
	if err != nil {
		return false, fmt.Errorf("get environment: %w", err)
	}
	active, err := q.HasActiveRun(ctx, HasActiveRunParams{EnvironmentID: s.EnvironmentID, Type: s.RunType})
	if err != nil {
		return false, fmt.Errorf("check active run: %w", err)
	}
	if active {
		return false, nil
	}
	budget, _ := run.Budget{}.Resolve() // defaults
	_, err = run.Create(ctx, pool, run.CreateInput{OrganizationID: s.OrganizationID, Actor: "scheduler", Env: env, Type: s.RunType, Trigger: "schedule", Budget: budget})
	if errors.Is(err, run.ErrProduction) || errors.Is(err, run.ErrNothingToTest) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("create scheduled run: %w", err)
	}
	return true, nil
}

// Loop ticks until ctx ends. Errors are logged, never fatal: the next tick retries.
func Loop(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			res, err := Tick(ctx, pool, now)
			if err != nil {
				log.Error("scheduler tick failed", "err", err)
			} else if res.Created > 0 {
				log.Info("scheduled runs created", "created", res.Created, "skipped", res.Skipped)
			}
		}
	}
}
