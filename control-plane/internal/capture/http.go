package capture

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

// Register mounts the UI-facing capture endpoints. The runner-facing ones live in runnerapi (runner-token auth).
func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool, hub *Hub) {
	envs := environment.New(pool)
	write := func(h http.HandlerFunc) http.Handler { return mw(auth.RequireWriter(h)) }

	mux.Handle("POST /api/v1/environments/{id}/capture", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			AppRole  string `json:"app_role"`
			StartURL string `json:"start_url"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		in.AppRole = strings.TrimSpace(in.AppRole)
		if in.AppRole == "" {
			httpx.Error(w, http.StatusBadRequest, "app_role is required")
			return
		}
		env, err := envs.GetEnvironment(r.Context(), environment.GetEnvironmentParams{OrganizationID: p.OrganizationID, ID: eid})
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "environment not found")
			return
		}
		start := strings.TrimSpace(in.StartURL)
		if start == "" {
			start = env.BaseUrl
		} else if !strings.HasPrefix(start, "http://") && !strings.HasPrefix(start, "https://") {
			httpx.Error(w, http.StatusBadRequest, "start_url must be http(s)")
			return
		}
		v := hub.Create(p.OrganizationID, eid, p.UserID, in.AppRole, start)
		httpx.WriteJSON(w, http.StatusCreated, v)
	}))

	mux.Handle("GET /api/v1/capture/{id}", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		v, ok := hub.Status(id, p.OrganizationID)
		if !ok {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, v)
	})))

	mux.Handle("GET /api/v1/capture/{id}/stream", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			httpx.Error(w, http.StatusInternalServerError, "streaming unsupported")
			return
		}
		frames, done, replay, unsubscribe, ok := hub.Subscribe(id, p.OrganizationID)
		if !ok {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		defer unsubscribe()
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		_, _ = fmt.Fprint(w, "event: ready\ndata: {}\n\n")
		if len(replay) > 0 {
			_, _ = fmt.Fprintf(w, "event: frame\ndata: %s\n\n", replay)
		}
		flusher.Flush()
		keepalive := time.NewTicker(20 * time.Second)
		defer keepalive.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-done:
				if v, ok := hub.Status(id, p.OrganizationID); ok {
					_, _ = fmt.Fprintf(w, "event: end\ndata: {\"status\":%q}\n\n", v.Status)
					flusher.Flush()
				}
				return
			case f := <-frames:
				_, _ = fmt.Fprintf(w, "event: frame\ndata: %s\n\n", f)
				flusher.Flush()
			case <-keepalive.C:
				_, _ = fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
			}
		}
	})))

	mux.Handle("POST /api/v1/capture/{id}/input", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Events []Input `json:"events"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		if len(in.Events) > 100 {
			httpx.Error(w, http.StatusBadRequest, "too many events")
			return
		}
		if !hub.Enqueue(id, p.OrganizationID, in.Events) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.Handle("POST /api/v1/capture/{id}/finish", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if !hub.Finish(id, p.OrganizationID) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.Handle("POST /api/v1/capture/{id}/cancel", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if !hub.Cancel(id, p.OrganizationID) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
}
