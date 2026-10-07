package bug

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/knowledge"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
)

// View is the API shape of a bug; shared with the run report.
type View struct {
	ID       uuid.UUID `json:"id"`
	Title    string    `json:"title"`
	Status   string    `json:"status"`
	Severity string    `json:"severity"`
	// Category separates what the tests found ("functional") from what the security checks found ("security").
	Category       string     `json:"category"`
	Check          *string    `json:"check,omitempty"`
	Fingerprint    string     `json:"fingerprint"`
	RequirementID  *uuid.UUID `json:"requirement_id"`
	NodeID         *uuid.UUID `json:"node_id"`
	FirstSeenRunID uuid.UUID  `json:"first_seen_run_id"`
	LastSeenRunID  uuid.UUID  `json:"last_seen_run_id"`
	FixedInRunID   *uuid.UUID `json:"fixed_in_run_id"`
	// Users are the users the defect was seen for (an empty name is a check that belongs to none, like an API call).
	Users []string `json:"users"`
}

func ToView(b Bug) View {
	v := View{ID: b.ID, Title: b.Title, Status: b.Status, Severity: b.Severity, Category: b.Category, Check: b.SecurityCheck, Fingerprint: b.Fingerprint,
		FirstSeenRunID: b.FirstSeenRunID, LastSeenRunID: b.LastSeenRunID, Users: []string{}}
	if b.RequirementID.Valid {
		v.RequirementID = &b.RequirementID.UUID
	}
	if b.NodeID.Valid {
		v.NodeID = &b.NodeID.UUID
	}
	if b.FixedInRunID.Valid {
		v.FixedInRunID = &b.FixedInRunID.UUID
	}
	return v
}

type occurrenceView struct {
	ID        uuid.UUID `json:"id"`
	RunID     uuid.UUID `json:"run_id"`
	RunStepID uuid.UUID `json:"run_step_id"`
	RunType   string    `json:"run_type"`
	Result    *string   `json:"result"`
	Actual    string    `json:"actual"`
	At        time.Time `json:"at"`
}

type detailView struct {
	View
	Occurrences []occurrenceView `json:"occurrences"`
}

var validStatuses = map[string]bool{"new": true, "confirmed": true, "fixed": true, "false_positive": true, "reopened": true}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	q := New(pool)
	write := func(h http.HandlerFunc) http.Handler { return mw(auth.RequireWriter(h)) }

	mux.Handle("GET /api/v1/projects/{id}/bugs", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		pid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var status *string
		if s := r.URL.Query().Get("status"); s != "" {
			if !validStatuses[s] {
				httpx.Error(w, http.StatusBadRequest, "unknown status")
				return
			}
			status = &s
		}
		var category *string
		if c := r.URL.Query().Get("category"); c != "" {
			if c != "functional" && c != "security" {
				httpx.Error(w, http.StatusBadRequest, "unknown category")
				return
			}
			category = &c
		}
		rows, err := q.ListBugs(r.Context(), ListBugsParams{OrganizationID: p.OrganizationID, ProjectID: pid, Status: status, Category: category})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]View, 0, len(rows))
		ids := make([]uuid.UUID, 0, len(rows))
		for _, b := range rows {
			out = append(out, ToView(b))
			ids = append(ids, b.ID)
		}
		if err := attachUsers(r.Context(), q, p.OrganizationID, out, ids); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("GET /api/v1/bugs/{id}", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		b, ok := load(w, r, q, p.OrganizationID)
		if !ok {
			return
		}
		occ, err := q.ListBugOccurrences(r.Context(), ListBugOccurrencesParams{OrganizationID: p.OrganizationID, BugID: b.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		d := detailView{View: ToView(b), Occurrences: make([]occurrenceView, 0, len(occ))}
		one := []View{d.View}
		if err := attachUsers(r.Context(), q, p.OrganizationID, one, []uuid.UUID{b.ID}); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		d.View = one[0]
		for _, o := range occ {
			d.Occurrences = append(d.Occurrences, occurrenceView{ID: o.ID, RunID: o.RunID, RunStepID: o.RunStepID, RunType: o.RunType, Result: o.Result, Actual: o.Actual, At: o.CreatedAt.Time})
		}
		httpx.WriteJSON(w, http.StatusOK, d)
	})))

	mux.Handle("POST /api/v1/bugs/{id}/status", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		var in struct {
			Status string `json:"status"`
			Reason string `json:"reason"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		in.Reason = strings.TrimSpace(in.Reason)
		if !validStatuses[in.Status] || in.Status == "new" {
			httpx.Error(w, http.StatusBadRequest, "unknown status")
			return
		}
		if in.Status == "false_positive" && in.Reason == "" {
			httpx.Error(w, http.StatusBadRequest, "reason is required to mark a false positive")
			return
		}
		b, ok := load(w, r, q, p.OrganizationID)
		if !ok {
			return
		}
		if !CanTransition(b.Status, in.Status) {
			httpx.Error(w, http.StatusConflict, fmt.Sprintf("cannot move a %s bug to %s", b.Status, in.Status))
			return
		}
		updated, err := changeStatus(r.Context(), pool, p, b, in.Status, in.Reason)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, ToView(updated))
	}))

	// Reproduce: a regression restricted to the bug's node, found again in the newest graph by fingerprint.
	mux.Handle("POST /api/v1/bugs/{id}/reproduce", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		b, ok := load(w, r, q, p.OrganizationID)
		if !ok {
			return
		}
		created, err := reproduce(r.Context(), pool, p, b)
		if errors.Is(err, errNotReproducible) {
			httpx.Error(w, http.StatusConflict, "the bug's node is not covered in the latest graph")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, run.ToView(created))
	}))
}

func load(w http.ResponseWriter, r *http.Request, q *Queries, org uuid.UUID) (Bug, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not found")
		return Bug{}, false
	}
	b, err := q.GetBug(r.Context(), GetBugParams{OrganizationID: org, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not found")
		return Bug{}, false
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal error")
		return Bug{}, false
	}
	return b, true
}

func changeStatus(ctx context.Context, pool *pgxpool.Pool, p auth.Principal, b Bug, to, reason string) (Bug, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Bug{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	updated, err := New(tx).SetBugStatus(ctx, SetBugStatusParams{OrganizationID: p.OrganizationID, ID: b.ID, Status: to})
	if err != nil {
		return Bug{}, err
	}
	if to == "false_positive" { // CLAUDE.md 8.5: a false positive becomes knowledge for the next runs
		content := fmt.Sprintf("Falso positivo: %s — motivo: %s", b.Title, reason)
		if _, err := knowledge.New(tx).CreateKnowledge(ctx, knowledge.CreateKnowledgeParams{
			OrganizationID: p.OrganizationID, ProjectID: b.ProjectID, Content: content, Origin: "false_positive", OriginID: uuid.NullUUID{UUID: b.ID, Valid: true},
		}); err != nil {
			return Bug{}, err
		}
	}
	payload, _ := json.Marshal(map[string]string{"from": b.Status, "to": to})
	if err := audit.New(tx).RecordAudit(ctx, audit.RecordAuditParams{
		OrganizationID: p.OrganizationID, Actor: p.UserID.String(), Action: "bug.status", Target: b.ID.String(), Payload: payload,
	}); err != nil {
		return Bug{}, err
	}
	return updated, tx.Commit(ctx)
}

var errNotReproducible = errors.New("bug node not covered in latest graph")

func reproduce(ctx context.Context, pool *pgxpool.Pool, p auth.Principal, b Bug) (run.Run, error) {
	org := p.OrganizationID
	seen, err := run.New(pool).GetRun(ctx, run.GetRunParams{OrganizationID: org, ID: b.LastSeenRunID})
	if err != nil {
		return run.Run{}, err
	}
	gq := graph.New(pool)
	g, err := gq.GetLatestGraph(ctx, graph.GetLatestGraphParams{OrganizationID: org, EnvironmentID: seen.EnvironmentID})
	if errors.Is(err, pgx.ErrNoRows) {
		return run.Run{}, errNotReproducible
	}
	if err != nil {
		return run.Run{}, err
	}
	node, err := gq.GetNodeByFingerprint(ctx, graph.GetNodeByFingerprintParams{OrganizationID: org, GraphID: g.ID, Fingerprint: b.NodeFingerprint})
	if errors.Is(err, pgx.ErrNoRows) {
		return run.Run{}, errNotReproducible
	}
	if err != nil {
		return run.Run{}, err
	}
	covered, err := run.New(pool).ListCoveredNodes(ctx, run.ListCoveredNodesParams{OrganizationID: org, GraphID: g.ID})
	if err != nil {
		return run.Run{}, err
	}
	isCovered := false
	for _, c := range covered {
		isCovered = isCovered || c.ID == node.ID
	}
	if !isCovered {
		return run.Run{}, errNotReproducible
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return run.Run{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	budget, _ := json.Marshal(map[string]int{"max_pages": 50, "max_depth": 4, "max_seconds": 600, "max_llm_calls": 0})
	created, err := run.New(tx).CreateRegressionRun(ctx, run.CreateRegressionRunParams{
		OrganizationID: org, ProjectID: b.ProjectID, EnvironmentID: seen.EnvironmentID, GraphID: uuid.NullUUID{UUID: g.ID, Valid: true},
		Trigger: "manual", Budget: budget, TargetNodeIds: []uuid.UUID{node.ID}, RequiredLabels: runLabels(seen),
	})
	if err != nil {
		return run.Run{}, err
	}
	payload, _ := json.Marshal(map[string]any{"type": "regression", "reproduce_bug": b.ID, "node": node.ID})
	if err := audit.New(tx).RecordAudit(ctx, audit.RecordAuditParams{
		OrganizationID: org, Actor: p.UserID.String(), Action: "run.create", Target: created.ID.String(), Payload: payload,
	}); err != nil {
		return run.Run{}, err
	}
	return created, tx.Commit(ctx)
}

// runLabels carries the runner requirements of the run the bug was seen in over to its reproduction.
func runLabels(r run.Run) []string {
	if r.RequiredLabels == nil {
		return []string{}
	}
	return r.RequiredLabels
}

// attachUsers fills who each bug affects with one query.
func attachUsers(ctx context.Context, q *Queries, org uuid.UUID, views []View, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListBugUsers(ctx, ListBugUsersParams{OrganizationID: org, BugIds: ids})
	if err != nil {
		return err
	}
	at := make(map[uuid.UUID]int, len(views))
	for i, v := range views {
		at[v.ID] = i
	}
	for _, r := range rows {
		if i, ok := at[r.BugID]; ok && r.AppRole != "" {
			views[i].Users = append(views[i].Users, r.AppRole)
		}
	}
	return nil
}
