package step

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

// Storage is the part of the object store the history API needs. nil means no storage is configured.
type Storage interface {
	Get(ctx context.Context, key string) (io.ReadCloser, error)
}

type artifactView struct {
	ID          uuid.UUID `json:"id"`
	Kind        string    `json:"kind"`
	ContentType string    `json:"content_type"`
	Size        int64     `json:"size"`
}

type stepView struct {
	ID         uuid.UUID       `json:"id"`
	RunID      uuid.UUID       `json:"run_id"`
	RunType    string          `json:"run_type,omitempty"`
	RunStatus  string          `json:"run_status,omitempty"`
	NodeID     *uuid.UUID      `json:"node_id"`
	Executor   string          `json:"executor"`
	Input      json.RawMessage `json:"input"`
	Expected   string          `json:"expected"`
	Actual     string          `json:"actual"`
	Result     *string         `json:"result"`
	StartedAt  *time.Time      `json:"started_at"`
	FinishedAt *time.Time      `json:"finished_at"`
	Artifacts  []artifactView  `json:"artifacts"`
	// Security is set when the step is a security check: which one, how serious and what it looked at.
	Security json.RawMessage `json:"security,omitempty"`
	// User is who the step ran as: the user the node belongs to. Empty for checks that have none (API calls).
	User string `json:"user"`
}

const historyLimit = 100

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool, store Storage) {
	q := New(pool)

	// withArtifacts attaches evidence to steps with one query.
	withArtifacts := func(ctx context.Context, org uuid.UUID, views []stepView) ([]stepView, error) {
		if len(views) == 0 {
			return []stepView{}, nil
		}
		ids := make([]uuid.UUID, len(views))
		idx := make(map[uuid.UUID]int, len(views))
		for i, v := range views {
			ids[i] = v.ID
			idx[v.ID] = i
			views[i].Artifacts = []artifactView{}
		}
		arts, err := q.ListArtifactsForSteps(ctx, ListArtifactsForStepsParams{OrganizationID: org, StepIds: ids})
		if err != nil {
			return nil, err
		}
		var nodeIDs []uuid.UUID
		for _, v := range views {
			if v.NodeID != nil {
				nodeIDs = append(nodeIDs, *v.NodeID)
			}
		}
		roles, err := q.ListNodeRoles(ctx, ListNodeRolesParams{OrganizationID: org, Ids: nodeIDs})
		if err != nil {
			return nil, err
		}
		userOf := make(map[uuid.UUID]string, len(roles))
		for _, n := range roles {
			if len(n.AppRoles) > 0 {
				userOf[n.ID] = n.AppRoles[0]
			}
		}
		for i, v := range views {
			if v.NodeID != nil {
				views[i].User = userOf[*v.NodeID]
			}
		}
		for _, a := range arts {
			i := idx[a.RunStepID]
			views[i].Artifacts = append(views[i].Artifacts, artifactView{ID: a.ID, Kind: a.Kind, ContentType: a.ContentType, Size: a.Size})
		}
		return views, nil
	}

	mux.Handle("GET /api/v1/nodes/{id}/history", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		nid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListStepsByNode(r.Context(), ListStepsByNodeParams{OrganizationID: p.OrganizationID, NodeID: uuid.NullUUID{UUID: nid, Valid: true}, Limit: historyLimit})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		views := make([]stepView, 0, len(rows))
		for _, s := range rows {
			v := toView(RunStep{ID: s.ID, RunID: s.RunID, NodeID: s.NodeID, Executor: s.Executor, InputMasked: s.InputMasked, Expected: s.Expected,
				Actual: s.Actual, Result: s.Result, StartedAt: s.StartedAt, FinishedAt: s.FinishedAt, Security: s.Security})
			v.RunType, v.RunStatus = s.RunType, s.RunStatus
			views = append(views, v)
		}
		views, err = withArtifacts(r.Context(), p.OrganizationID, views)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, views)
	})))

	mux.Handle("GET /api/v1/runs/{id}/steps", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		rid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		f, ok := parseStepFilter(r)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "result must be pass, fail, error, skipped or running (comma separated); kind functional, security or all; limit 1-500; offset 0 or more")
			return
		}
		rows, err := q.ListStepsPage(r.Context(), ListStepsPageParams{OrganizationID: p.OrganizationID, RunID: rid, Results: f.results, AppRole: f.user, Security: f.security, PageSize: f.limit, PageOffset: f.offset})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		total, err := q.CountStepsPage(r.Context(), CountStepsPageParams{OrganizationID: p.OrganizationID, RunID: rid, Results: f.results, AppRole: f.user, Security: f.security})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		w.Header().Set("X-Total-Count", strconv.Itoa(int(total)))
		views := make([]stepView, 0, len(rows))
		for _, s := range rows {
			views = append(views, toView(s))
		}
		views, err = withArtifacts(r.Context(), p.OrganizationID, views)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, views)
	})))

	// What a run said about each node (the worst verdict): for views that need the whole run without its weight.
	mux.Handle("GET /api/v1/runs/{id}/node-results", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		rid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.RunNodeResults(r.Context(), RunNodeResultsParams{OrganizationID: p.OrganizationID, RunID: rid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			out = append(out, map[string]any{"node_id": row.NodeID.UUID, "result": row.Result})
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	// The screenshot of a screen, taken while exploring: served like evidence, through the API.
	mux.Handle("GET /api/v1/nodes/{id}/thumbnail", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		t, err := q.GetNodeThumbnail(r.Context(), GetNodeThumbnailParams{OrganizationID: p.OrganizationID, ID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if store == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "storage is not configured")
			return
		}
		body, err := store.Get(r.Context(), *t.ThumbnailKey)
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "thumbnail not found")
			return
		}
		defer func() { _ = body.Close() }()
		ct := "image/jpeg"
		if t.ThumbnailContentType != nil {
			ct = *t.ThumbnailContentType
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		w.Header().Set("Cache-Control", "private, max-age=300")
		_, _ = io.Copy(w, body)
	})))

	// Evidence is served through the API (authenticated, same origin) instead of public presigned URLs.
	mux.Handle("GET /api/v1/artifacts/{id}/content", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		a, err := q.GetArtifact(r.Context(), GetArtifactParams{OrganizationID: p.OrganizationID, ID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if store == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "storage is not configured")
			return
		}
		body, err := store.Get(r.Context(), a.StorageKey)
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "evidence not found")
			return
		}
		defer func() { _ = body.Close() }()
		// Evidence comes from the tested application: never let a browser interpret it as a page.
		w.Header().Set("Content-Type", a.ContentType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		w.Header().Set("Cache-Control", "private, max-age=300")
		_, _ = io.Copy(w, body)
	})))
}

const (
	defaultStepPage = 200
	maxStepPage     = 500
)

type stepFilter struct {
	results       []string
	user          *string
	security      pgtype.Bool // not valid: both kinds; the list of a run opens on the functional steps
	limit, offset int32
}

// parseStepFilter reads ?result=fail,error&user=operador&limit=200&offset=0. A run can have thousands of steps, so the list
// is paged; the total comes in X-Total-Count and the problems come first.
func parseStepFilter(r *http.Request) (stepFilter, bool) {
	q := r.URL.Query()
	f := stepFilter{limit: defaultStepPage}
	switch q.Get("kind") {
	case "", "functional":
		f.security = pgtype.Bool{Bool: false, Valid: true}
	case "security":
		f.security = pgtype.Bool{Bool: true, Valid: true}
	case "all":
	default:
		return f, false
	}
	if raw := q.Get("result"); raw != "" {
		for _, v := range strings.Split(raw, ",") {
			switch v = strings.TrimSpace(v); v {
			case "pass", "fail", "error", "skipped", "running":
				f.results = append(f.results, v)
			default:
				return f, false
			}
		}
	}
	if q.Has("user") {
		u := q.Get("user")
		f.user = &u
	}
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 32) // 32 bits by construction: it fits what the query takes
		if err != nil || n < 1 || n > maxStepPage {
			return f, false
		}
		f.limit = int32(n)
	}
	if raw := q.Get("offset"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || n < 0 {
			return f, false
		}
		f.offset = int32(min(n, 1_000_000))
	}
	return f, true
}

func toView(s RunStep) stepView {
	v := stepView{ID: s.ID, RunID: s.RunID, Executor: s.Executor, Input: s.InputMasked, Expected: s.Expected, Actual: s.Actual, Result: s.Result, Artifacts: []artifactView{}}
	if len(s.Security) > 0 {
		v.Security = s.Security
	}
	if s.NodeID.Valid {
		v.NodeID = &s.NodeID.UUID
	}
	if s.StartedAt.Valid {
		v.StartedAt = &s.StartedAt.Time
	}
	if s.FinishedAt.Valid {
		v.FinishedAt = &s.FinishedAt.Time
	}
	return v
}
