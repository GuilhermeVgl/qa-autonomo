package runnerapi

import (
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/capture"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

// registerCapture mounts the runner side of the remote-browser capture: lease a session, push frames, poll for input,
// and upload the captured storageState. Frames are raw JPEG bodies; everything else is JSON.
func registerCapture(mux *http.ServeMux, auth func(http.HandlerFunc) http.Handler, runnerOf func(*http.Request) Runner, hub *capture.Hub) {
	const maxFrame = 2 << 20

	mux.Handle("POST /runner/v1/capture/lease", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		wait := 25 * time.Second
		if v := r.URL.Query().Get("wait"); v != "" {
			ms, err := strconv.Atoi(v)
			if err != nil || ms < 0 {
				httpx.Error(w, http.StatusBadRequest, "invalid wait")
				return
			}
			wait = min(time.Duration(ms)*time.Millisecond, 30*time.Second)
		}
		v, ok := hub.Lease(r.Context(), runner.OrganizationID, runner.ID, wait)
		if !ok {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		httpx.WriteJSON(w, http.StatusOK, v)
	}))

	captureID := func(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return uuid.Nil, false
		}
		return id, true
	}

	mux.Handle("POST /runner/v1/capture/{id}/frame", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		id, ok := captureID(w, r)
		if !ok {
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxFrame+1))
		if err != nil || len(body) > maxFrame {
			httpx.Error(w, http.StatusBadRequest, "frame too large")
			return
		}
		if !hub.PushFrame(id, runner.OrganizationID, runner.ID, body) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.Handle("POST /runner/v1/capture/{id}/poll", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		id, ok := captureID(w, r)
		if !ok {
			return
		}
		wait := 20 * time.Second
		if v := r.URL.Query().Get("wait"); v != "" {
			ms, err := strconv.Atoi(v)
			if err != nil || ms < 0 {
				httpx.Error(w, http.StatusBadRequest, "invalid wait")
				return
			}
			wait = min(time.Duration(ms)*time.Millisecond, 25*time.Second)
		}
		events, finish, cancel, found := hub.Poll(r.Context(), id, runner.OrganizationID, runner.ID, wait)
		if !found {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if events == nil {
			events = []capture.Input{}
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"events": events, "finish": finish, "cancel": cancel})
	}))

	mux.Handle("POST /runner/v1/capture/{id}/result", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		id, ok := captureID(w, r)
		if !ok {
			return
		}
		var in struct {
			State string `json:"state"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		if in.State == "" {
			httpx.Error(w, http.StatusBadRequest, "state is required")
			return
		}
		if err := hub.Result(r.Context(), id, runner.OrganizationID, runner.ID, in.State); err != nil {
			if err == capture.ErrNotFound {
				httpx.Error(w, http.StatusNotFound, "not found")
				return
			}
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.Handle("POST /runner/v1/capture/{id}/failed", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		id, ok := captureID(w, r)
		if !ok {
			return
		}
		hub.Fail(id, runner.OrganizationID, runner.ID)
		w.WriteHeader(http.StatusNoContent)
	}))
}
