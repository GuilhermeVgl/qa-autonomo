// Package runnerapi implements /runner/v1, the only surface runners talk to (outbound-only, token auth).
package runnerapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/autospec"
	"github.com/kpmg/agent-qa/control-plane/internal/bug"
	"github.com/kpmg/agent-qa/control-plane/internal/capture"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/events"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/openapi"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/secret"
	"github.com/kpmg/agent-qa/control-plane/internal/step"
)

// Completer is the LLM gateway as the runner API sees it. nil means no LLM is configured (503).
type Completer interface {
	Complete(ctx context.Context, orgID uuid.UUID, task string, msgs []llm.Message, jsonMode bool) (string, error)
}

// Storage is the object store as the runner API uses it; nil means evidence is disabled (503).
type Storage interface {
	Size(ctx context.Context, key string) (int64, error)
	Delete(ctx context.Context, key string) error
	PresignPut(ctx context.Context, key string, ttl time.Duration) (string, error)
}

type Deps struct {
	Storage        Storage
	LLM            Completer
	Box            *secret.Box
	Capture        *capture.Hub
	BootstrapToken string // empty disables registration
	OrganizationID uuid.UUID
	PollInterval   time.Duration // long-poll check interval (default 1s)
}

const (
	maxLeaseWait   = 30 * time.Second
	maxEventsBatch = 500
)

// Tasks a runner may ask for; extraction and summarising stay control-plane only.
var runnerTasks = map[string]bool{"explore": true, "plan": true, "judge_result": true}

const (
	maxChatBody     = 512 << 10
	maxChatMessages = 20
	maxChatChars    = 100_000
)

func validChat(msgs []llm.Message) bool {
	if len(msgs) == 0 || len(msgs) > maxChatMessages {
		return false
	}
	total := 0
	for _, m := range msgs {
		if m.Role != "system" && m.Role != "user" && m.Role != "assistant" {
			return false
		}
		total += len(m.Content)
	}
	return total <= maxChatChars
}

type ctxKey struct{}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func Register(mux *http.ServeMux, pool *pgxpool.Pool, d Deps) {
	if d.PollInterval == 0 {
		d.PollInterval = time.Second
	}
	rq := New(pool)
	runs := run.New(pool)
	envs := environment.New(pool)

	auth := func(h http.HandlerFunc) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || token == "" {
				httpx.Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			runner, err := rq.GetRunnerByTokenHash(r.Context(), hashToken(token))
			if err != nil {
				httpx.Error(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			_ = rq.TouchRunner(r.Context(), runner.ID)
			h(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, runner)))
		})
	}
	runnerOf := func(r *http.Request) Runner { return r.Context().Value(ctxKey{}).(Runner) }

	if d.Capture != nil {
		registerCapture(mux, auth, runnerOf, d.Capture)
	}

	mux.HandleFunc("POST /runner/v1/register", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			BootstrapToken string   `json:"bootstrap_token"`
			Name           string   `json:"name"`
			Labels         []string `json:"labels"`
			Version        string   `json:"version"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		a, b := sha256.Sum256([]byte(in.BootstrapToken)), sha256.Sum256([]byte(d.BootstrapToken))
		if d.BootstrapToken == "" || subtle.ConstantTimeCompare(a[:], b[:]) != 1 {
			httpx.Error(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" || len(in.Name) > 100 {
			httpx.Error(w, http.StatusBadRequest, "name is required (max 100 chars)")
			return
		}
		if in.Labels == nil {
			in.Labels = []string{}
		}
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		token := "qar_" + base64.RawURLEncoding.EncodeToString(raw)
		row, err := rq.CreateRunner(r.Context(), CreateRunnerParams{
			OrganizationID: d.OrganizationID, Name: in.Name, TokenHash: hashToken(token), Labels: in.Labels, Version: in.Version,
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"runner_id": row.ID, "token": token})
	})

	mux.Handle("POST /runner/v1/jobs/lease", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		wait := maxLeaseWait
		if v := r.URL.Query().Get("wait"); v != "" {
			ms, err := strconv.Atoi(v)
			if err != nil || ms < 0 {
				httpx.Error(w, http.StatusBadRequest, "invalid wait")
				return
			}
			wait = min(time.Duration(ms)*time.Millisecond, maxLeaseWait)
		}
		deadline := time.Now().Add(wait)
		for {
			claimed, ok, err := claim(r.Context(), runs, runner)
			if err != nil {
				httpx.Error(w, http.StatusInternalServerError, "internal error")
				return
			}
			if ok {
				j, err := buildJob(r.Context(), pool, envs, runs, d.Box, claimed)
				if err != nil {
					httpx.Error(w, http.StatusInternalServerError, "internal error")
					return
				}
				httpx.WriteJSON(w, http.StatusOK, j)
				return
			}
			if !time.Now().Add(d.PollInterval).Before(deadline) {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			select {
			case <-time.After(d.PollInterval):
			case <-r.Context().Done():
				return
			}
		}
	}))

	mux.Handle("POST /runner/v1/jobs/{id}/heartbeat", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		id, ok := jobID(w, r)
		if !ok {
			return
		}
		_, err := runs.HeartbeatRun(r.Context(), run.HeartbeatRunParams{OrganizationID: runner.OrganizationID, ID: id, RunnerID: uuidNull(runner.ID)})
		if err == nil {
			httpx.WriteJSON(w, http.StatusOK, map[string]bool{"cancel": false})
			return
		}
		cur, ok := ownedRun(w, r, runs, runner, id)
		if !ok {
			return
		}
		if cur.Status == "cancelled" {
			httpx.WriteJSON(w, http.StatusOK, map[string]bool{"cancel": true})
			return
		}
		httpx.Error(w, http.StatusConflict, "lease lost")
	}))

	mux.Handle("POST /runner/v1/jobs/{id}/events", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		id, ok := jobID(w, r)
		if !ok {
			return
		}
		var in struct {
			Events []rawEvent `json:"events"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		if len(in.Events) == 0 || len(in.Events) > maxEventsBatch {
			httpx.Error(w, http.StatusBadRequest, "events must have 1.."+strconv.Itoa(maxEventsBatch)+" items")
			return
		}
		applies := make([]func(context.Context, *graphWriter) error, len(in.Events))
		for i, e := range in.Events {
			a, err := e.parse()
			if err != nil {
				httpx.Error(w, http.StatusBadRequest, fmt.Sprintf("event %d: %v", i, err))
				return
			}
			applies[i] = a
		}
		cur, ok := ownedRun(w, r, runs, runner, id)
		if !ok {
			return
		}
		if cur.Status != "running" {
			httpx.Error(w, http.StatusConflict, "run is not running")
			return
		}
		err := applyBatch(r.Context(), pool, d.Storage, cur, in.Events, applies)
		switch {
		case errors.Is(err, errBadEvent):
			httpx.Error(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, errNoStorage):
			httpx.Error(w, http.StatusServiceUnavailable, "storage is not configured")
		case err != nil:
			httpx.Error(w, http.StatusInternalServerError, "internal error")
		default:
			httpx.WriteJSON(w, http.StatusOK, map[string]int{"accepted": len(in.Events)})
		}
	}))

	// OpenAI-compatible proxy: the runner never sees LLM credentials and cannot pick the model (CLAUDE.md, seções 4.2 e 11).
	mux.Handle("POST /runner/v1/llm/chat/completions", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		runID, err := uuid.Parse(r.Header.Get("X-QA-Run-Id"))
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, "X-QA-Run-Id header is required")
			return
		}
		task := r.Header.Get("X-QA-Task")
		if task == "" {
			task = "explore"
		}
		if !runnerTasks[task] {
			httpx.Error(w, http.StatusBadRequest, "task not allowed for runners")
			return
		}
		var in struct {
			Messages       []llm.Message `json:"messages"`
			ResponseFormat *struct {
				Type string `json:"type"`
			} `json:"response_format"`
		}
		// not strict: the OpenAI SDK sends fields (model, temperature...) that the gateway ignores
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxChatBody)).Decode(&in); err != nil || !validChat(in.Messages) {
			httpx.Error(w, http.StatusBadRequest, "invalid chat request")
			return
		}
		cur, ok := ownedRun(w, r, runs, runner, runID)
		if !ok {
			return
		}
		if cur.Status != "running" {
			httpx.Error(w, http.StatusConflict, "run is not running")
			return
		}
		if d.LLM == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "LLM is not configured")
			return
		}
		jsonMode := in.ResponseFormat != nil && in.ResponseFormat.Type == "json_object"
		out, err := d.LLM.Complete(llm.WithRun(r.Context(), runID), runner.OrganizationID, task, in.Messages, jsonMode)
		if err != nil {
			httpx.Error(w, http.StatusBadGateway, "LLM call failed")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"object": "chat.completion",
			"choices": []map[string]any{{
				"index": 0, "finish_reason": "stop",
				"message": map[string]string{"role": "assistant", "content": out},
			}},
		})
	}))

	// Runners upload evidence straight to object storage with a presigned URL scoped to <org>/<run>/<id>.<ext>.
	mux.Handle("POST /runner/v1/jobs/{id}/artifacts", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		id, ok := jobID(w, r)
		if !ok {
			return
		}
		var in struct {
			Kind        string `json:"kind"`
			ContentType string `json:"content_type"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		ext, ok := artifactExt(in.Kind, in.ContentType)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "unsupported kind/content_type")
			return
		}
		cur, ok := ownedRun(w, r, runs, runner, id)
		if !ok {
			return
		}
		if cur.Status != "running" {
			httpx.Error(w, http.StatusConflict, "run is not running")
			return
		}
		if d.Storage == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "storage is not configured")
			return
		}
		key := fmt.Sprintf("%s/%s/%s.%s", runner.OrganizationID, id, uuid.NewString(), ext)
		url, err := d.Storage.PresignPut(r.Context(), key, artifactTTL)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"storage_key": key, "upload_url": url, "expires_in": int(artifactTTL.Seconds())})
	}))

	mux.Handle("POST /runner/v1/jobs/{id}/complete", auth(func(w http.ResponseWriter, r *http.Request) {
		runner := runnerOf(r)
		id, ok := jobID(w, r)
		if !ok {
			return
		}
		var in struct {
			Status  string          `json:"status"`
			Summary json.RawMessage `json:"summary"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		if in.Status != "succeeded" && in.Status != "failed" {
			httpx.Error(w, http.StatusBadRequest, "status must be succeeded or failed")
			return
		}
		if len(in.Summary) == 0 {
			in.Summary = json.RawMessage(`{}`)
		}
		if !isJSONObject(in.Summary) {
			httpx.Error(w, http.StatusBadRequest, "summary must be an object")
			return
		}
		row, err := runs.CompleteRun(r.Context(), run.CompleteRunParams{
			OrganizationID: runner.OrganizationID, ID: id, RunnerID: uuidNull(runner.ID), Status: in.Status, Summary: in.Summary,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			if _, ok := ownedRun(w, r, runs, runner, id); ok {
				httpx.Error(w, http.StatusConflict, "run is not running")
			}
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if row.Type == "exploration" {
			// what a run that could not do its job leaves behind must not replace the map that was there; best effort
			if err := settleBlocked(r.Context(), pool, row, in.Summary); err != nil {
				slog.Warn("could not settle the map of a blocked exploration", "run_id", row.ID, "error", err)
			}
		}
		if in.Status == "succeeded" && row.Type == "exploration" {
			// the default spec follows the map; a failure here must not fail a run that already finished
			if err := autospec.Refresh(r.Context(), pool, runner.OrganizationID, row.EnvironmentID); err != nil {
				slog.Warn("automatic spec not refreshed", "run_id", row.ID, "error", err)
			}
		}
		httpx.WriteJSON(w, http.StatusOK, run.ToView(row))
	}))
}

// settleBlocked deals with the graph of an exploration that was blocked: the application was down or users could not log in.
//
// An exploration makes a new graph version up front. One that mapped nothing leaves an empty map as the newest, so the map
// that was there appears erased: the empty one is dropped. One that mapped some users but not others (a login that failed)
// would erase the others: what was known of them is carried over, since the run learned nothing new about them.
func settleBlocked(ctx context.Context, pool *pgxpool.Pool, row run.Run, summary json.RawMessage) error {
	var s struct {
		Pages         int      `json:"pages"`
		LoginFailures []string `json:"login_failures"`
		Blocked       *struct {
			Kind string `json:"kind"`
		} `json:"blocked"`
	}
	if json.Unmarshal(summary, &s) != nil || s.Blocked == nil || !row.GraphID.Valid || run.IsResume(row.Budget) {
		return nil // a continuation works on a graph that already held a map: it is never given up
	}
	org, gid := row.OrganizationID, row.GraphID.UUID
	gq := graph.New(pool)
	g, err := gq.GetGraph(ctx, graph.GetGraphParams{OrganizationID: org, ID: gid})
	if err != nil {
		return err
	}
	if !g.SourceRunID.Valid || g.SourceRunID.UUID != row.ID {
		return nil // not this run's own graph
	}
	prev, prevErr := gq.GetPreviousGraph(ctx, graph.GetPreviousGraphParams{OrganizationID: org, ID: gid})
	if prevErr != nil && !errors.Is(prevErr, pgx.ErrNoRows) {
		return prevErr
	}

	if s.Pages == 0 {
		steps, err := gq.CountStepsOfGraph(ctx, graph.CountStepsOfGraphParams{OrganizationID: org, GraphID: gid})
		if err != nil || steps > 0 {
			return err
		}
		tx, err := pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
		tq := graph.New(tx)
		if err := run.New(tx).DetachRunsFromGraph(ctx, run.DetachRunsFromGraphParams{OrganizationID: org, GraphID: uuidNull(gid)}); err != nil {
			return err
		}
		for _, del := range []func() error{
			func() error {
				return tq.DeleteGraphLinks(ctx, graph.DeleteGraphLinksParams{OrganizationID: org, GraphID: gid})
			},
			func() error {
				return tq.DeleteGraphEdges(ctx, graph.DeleteGraphEdgesParams{OrganizationID: org, GraphID: gid})
			},
			func() error {
				return tq.DeleteGraphNodes(ctx, graph.DeleteGraphNodesParams{OrganizationID: org, GraphID: gid})
			},
			func() error { return tq.DeleteGraph(ctx, graph.DeleteGraphParams{OrganizationID: org, ID: gid}) },
		} {
			if err := del(); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}

	if len(s.LoginFailures) == 0 || prevErr != nil {
		return nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	tq := graph.New(tx)
	if err := tq.CopyNodesOfOtherUsers(ctx, graph.CopyNodesOfOtherUsersParams{Org: org, FromGraph: prev.ID, ToGraph: gid, Explored: []string{}, Keep: s.LoginFailures}); err != nil {
		return err
	}
	if err := tq.CopyEdgesOfOtherUsers(ctx, graph.CopyEdgesOfOtherUsersParams{Org: org, FromGraph: prev.ID, ToGraph: gid, Explored: []string{}, Keep: s.LoginFailures}); err != nil {
		return err
	}
	if err := tq.CopyLinksOfOtherUsers(ctx, graph.CopyLinksOfOtherUsersParams{Org: org, FromGraph: prev.ID, ToGraph: gid, Explored: []string{}, Keep: s.LoginFailures}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func uuidNull(id uuid.UUID) uuid.NullUUID { return uuid.NullUUID{UUID: id, Valid: true} }

func jobID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not found")
		return uuid.Nil, false
	}
	return id, true
}

// ownedRun loads a run only if it is leased to this runner; otherwise it writes 404 (never reveals other runs).
func ownedRun(w http.ResponseWriter, r *http.Request, runs *run.Queries, runner Runner, id uuid.UUID) (run.Run, bool) {
	cur, err := runs.GetRunForRunner(r.Context(), run.GetRunForRunnerParams{OrganizationID: runner.OrganizationID, ID: id, RunnerID: uuidNull(runner.ID)})
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not found")
		return run.Run{}, false
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "internal error")
		return run.Run{}, false
	}
	return cur, true
}

// claim requeues expired leases, then claims the next eligible run. The partial unique index on
// runs(environment_id) WHERE status='running' is the real environment lock: losing that race is "no job".
func claim(ctx context.Context, runs *run.Queries, runner Runner) (run.Run, bool, error) {
	if err := runs.RequeueExpiredRuns(ctx, runner.OrganizationID); err != nil {
		return run.Run{}, false, fmt.Errorf("requeue expired: %w", err)
	}
	labels := runner.Labels
	if labels == nil {
		labels = []string{}
	}
	got, err := runs.ClaimNextRun(ctx, run.ClaimNextRunParams{OrganizationID: runner.OrganizationID, RunnerID: uuidNull(runner.ID), RunnerLabels: labels})
	if errors.Is(err, pgx.ErrNoRows) {
		return run.Run{}, false, nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return run.Run{}, false, nil
	}
	if err != nil {
		return run.Run{}, false, fmt.Errorf("claim run: %w", err)
	}
	return got, true, nil
}

type jobCredential struct {
	AppRole string            `json:"app_role"`
	Kind    string            `json:"kind"`
	Payload map[string]string `json:"payload"`
}

type job struct {
	RunID       uuid.UUID       `json:"run_id"`
	Attempt     int32           `json:"attempt"`
	GraphID     *uuid.UUID      `json:"graph_id"`
	Type        string          `json:"type"`
	Budget      json.RawMessage `json:"budget"`
	Environment jobEnvironment  `json:"environment"`
	Credentials []jobCredential `json:"credentials"`
	// Targets (regression only): the covered nodes to test, with where to find them and what to expect.
	Targets []jobTarget `json:"targets,omitempty"`
	// Resume (exploration only): what a continued exploration already knows, so it does not examine those screens again.
	Resume *jobResume `json:"resume,omitempty"`
}

type jobResume struct {
	// Generation is how many explorations came before on this graph: it keeps the test data of this one apart.
	Generation int32            `json:"generation"`
	Known      []jobKnownScreen `json:"known"`
}

type jobKnownScreen struct {
	Fingerprint string          `json:"fingerprint"`
	AppRole     string          `json:"app_role"`
	Followed    json.RawMessage `json:"followed,omitempty"` // where the actions on the screen led
}

type jobTarget struct {
	Kind            string    `json:"kind"` // page | endpoint
	NodeID          uuid.UUID `json:"node_id"`
	Fingerprint     string    `json:"fingerprint"`
	URL             string    `json:"url,omitempty"` // page
	Label           string    `json:"label"`
	AppRole         string    `json:"app_role"`
	RequirementKeys []string  `json:"requirement_keys"`
	// endpoint: what to call and what the contract says the answer must look like
	// command: the CLI invocation (arguments after the binary) and the shape of its --help when it was explored
	Args          []string          `json:"args,omitempty"`
	HelpSignature string            `json:"help_signature,omitempty"`
	Method        string            `json:"method,omitempty"`
	Path          string            `json:"path,omitempty"` // path parameters already substituted
	Query         map[string]string `json:"query,omitempty"`
	Status        int               `json:"status,omitempty"`
	Schema        map[string]any    `json:"schema,omitempty"`
	BodyRequired  bool              `json:"body_required,omitempty"`
	// Probes (page): where the security checks can try injections without changing anything: reads only.
	Probes []jobProbe `json:"probes,omitempty"`
}

// jobProbe is a read of a screen with parameters: the address of the screen itself or of a search form.
type jobProbe struct {
	URL    string   `json:"url"`
	Params []string `json:"params"`
}

type jobTerminal struct {
	Binary string `json:"binary"`
	Image  string `json:"image,omitempty"`
}

type jobEnvironment struct {
	Kind              string       `json:"kind"`               // web | terminal
	Terminal          *jobTerminal `json:"terminal,omitempty"` // terminal: the CLI under test
	Device            string       `json:"device,omitempty"`   // set: emulate this device (executor mobile_web)
	BaseURL           string       `json:"base_url"`
	AllowedHosts      []string     `json:"allowed_hosts"`
	DestructivePolicy string       `json:"destructive_policy"`
}

// buildJob decrypts the environment credentials for the runner; they travel only over this authenticated call.
func buildJob(ctx context.Context, pool *pgxpool.Pool, envs *environment.Queries, runs *run.Queries, box *secret.Box, r run.Run) (job, error) {
	env, err := envs.GetEnvironment(ctx, environment.GetEnvironmentParams{OrganizationID: r.OrganizationID, ID: r.EnvironmentID})
	if err != nil {
		return job{}, fmt.Errorf("get environment: %w", err)
	}
	rows, err := envs.ListCredentialSecrets(ctx, environment.ListCredentialSecretsParams{OrganizationID: r.OrganizationID, EnvironmentID: r.EnvironmentID})
	if err != nil {
		return job{}, fmt.Errorf("list credentials: %w", err)
	}
	creds := make([]jobCredential, 0, len(rows))
	only := run.RolesOf(r.Budget) // an exploration of some users only logs in as them
	for _, c := range rows {
		if r.Type == "exploration" && len(only) > 0 && !slices.Contains(only, c.AppRole) {
			continue
		}
		plain, err := box.Open(c.PayloadEncrypted)
		if err != nil {
			return job{}, fmt.Errorf("decrypt credential: %w", err)
		}
		var payload map[string]string
		if err := json.Unmarshal(plain, &payload); err != nil {
			return job{}, fmt.Errorf("decode credential: %w", err)
		}
		creds = append(creds, jobCredential{AppRole: c.AppRole, Kind: c.Kind, Payload: payload})
	}
	j := job{RunID: r.ID, Attempt: r.Attempts, Type: r.Type, Budget: r.Budget, Credentials: creds,
		Environment: jobEnvironment{Kind: env.Kind, Terminal: terminalOf(env), Device: deref(env.Device), BaseURL: env.BaseUrl, AllowedHosts: env.AllowedHosts, DestructivePolicy: env.DestructivePolicy}}
	if r.GraphID.Valid {
		j.GraphID = &r.GraphID.UUID
	}
	if r.Type == "exploration" && r.GraphID.Valid && run.IsResume(r.Budget) {
		resume, err := resumeOf(ctx, graph.New(pool), runs, r)
		if err != nil {
			return job{}, err
		}
		j.Resume = resume
	}
	if r.Type == "regression" && r.GraphID.Valid {
		targets, err := regressionTargets(ctx, runs, r.OrganizationID, r.GraphID.UUID, r.TargetNodeIds, run.SpecScope(r.Budget))
		if err != nil {
			return job{}, err
		}
		j.Targets = targets
	}
	return j, nil
}

// resumeOf lists what the graph of an interrupted exploration already holds: the screens of each user that were examined.
func resumeOf(ctx context.Context, gq *graph.Queries, runs *run.Queries, r run.Run) (*jobResume, error) {
	rows, err := gq.ListResumeNodes(ctx, graph.ListResumeNodesParams{OrganizationID: r.OrganizationID, GraphID: r.GraphID.UUID})
	if err != nil {
		return nil, fmt.Errorf("list known screens: %w", err)
	}
	total, err := runs.CountExplorationRunsOfGraph(ctx, run.CountExplorationRunsOfGraphParams{OrganizationID: r.OrganizationID, GraphID: r.GraphID})
	if err != nil {
		return nil, fmt.Errorf("count explorations: %w", err)
	}
	out := &jobResume{Generation: total - 1, Known: make([]jobKnownScreen, 0, len(rows))}
	for _, n := range rows {
		role := ""
		if len(n.AppRoles) > 0 {
			role = n.AppRoles[0]
		}
		k := jobKnownScreen{Fingerprint: n.Fingerprint, AppRole: role}
		if len(n.Followed) > 0 && string(n.Followed) != "null" {
			k.Followed = n.Followed
		}
		out.Known = append(out.Known, k)
	}
	return out, nil
}

// ---- events ----

var errBadEvent = errors.New("invalid event")

type rawEvent struct {
	Seq     int64           `json:"seq"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

var errNoStorage = errors.New("storage is not configured")

type graphWriter struct {
	q         *graph.Queries
	steps     *step.Queries
	bugs      *bug.Queries
	storage   Storage
	orgID     uuid.UUID
	projectID uuid.UUID
	runID     uuid.UUID
	graph     uuid.UUID
}

func strictDecode(raw json.RawMessage, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func isJSONObject(raw json.RawMessage) bool {
	var m map[string]json.RawMessage
	return json.Unmarshal(raw, &m) == nil && m != nil
}

func roles(role string) []string {
	if role == "" {
		return []string{}
	}
	return []string{role}
}

// parse validates an event offline and returns the function that applies it inside the batch transaction.
func (e rawEvent) parse() (func(context.Context, *graphWriter) error, error) {
	if e.Seq <= 0 {
		return nil, errors.New("seq must be positive")
	}
	switch e.Type {
	case "node_discovered":
		var p struct {
			Fingerprint string          `json:"fingerprint"`
			Kind        string          `json:"kind"`
			Label       string          `json:"label"`
			AppRole     string          `json:"app_role"`
			Metadata    json.RawMessage `json:"metadata"`
		}
		if err := strictDecode(e.Payload, &p); err != nil {
			return nil, fmt.Errorf("node_discovered payload: %w", err)
		}
		switch p.Kind {
		case "page", "modal", "endpoint", "command":
		default:
			return nil, errors.New("node kind must be page, modal, endpoint or command")
		}
		if p.Fingerprint == "" || len(p.Fingerprint) > 200 || p.Label == "" || len(p.Label) > 500 {
			return nil, errors.New("node needs fingerprint and label within limits")
		}
		if len(p.Metadata) == 0 {
			p.Metadata = json.RawMessage(`{}`)
		}
		if !isJSONObject(p.Metadata) {
			return nil, errors.New("metadata must be an object")
		}
		return func(ctx context.Context, g *graphWriter) error {
			_, err := g.q.UpsertNode(ctx, graph.UpsertNodeParams{OrganizationID: g.orgID, GraphID: g.graph, Kind: p.Kind,
				Fingerprint: p.Fingerprint, Label: p.Label, AppRoles: roles(p.AppRole), Metadata: p.Metadata})
			return err
		}, nil
	case "edge_discovered":
		var p struct {
			Key             string          `json:"key"`
			FromFingerprint string          `json:"from_fingerprint"`
			ToFingerprint   string          `json:"to_fingerprint"`
			Action          json.RawMessage `json:"action"`
			AppRole         string          `json:"app_role"`
		}
		if err := strictDecode(e.Payload, &p); err != nil {
			return nil, fmt.Errorf("edge_discovered payload: %w", err)
		}
		if p.Key == "" || len(p.Key) > 500 || p.FromFingerprint == "" || p.ToFingerprint == "" || !isJSONObject(p.Action) {
			return nil, errors.New("edge needs key, from/to fingerprints and an action object")
		}
		return func(ctx context.Context, g *graphWriter) error {
			from, err := g.q.GetNodeByFingerprint(ctx, graph.GetNodeByFingerprintParams{OrganizationID: g.orgID, GraphID: g.graph, Fingerprint: p.FromFingerprint})
			if err != nil {
				return unknownNode(err, p.FromFingerprint)
			}
			to, err := g.q.GetNodeByFingerprint(ctx, graph.GetNodeByFingerprintParams{OrganizationID: g.orgID, GraphID: g.graph, Fingerprint: p.ToFingerprint})
			if err != nil {
				return unknownNode(err, p.ToFingerprint)
			}
			_, err = g.q.UpsertEdge(ctx, graph.UpsertEdgeParams{OrganizationID: g.orgID, GraphID: g.graph, FromNodeID: from.ID, ToNodeID: to.ID,
				Key: p.Key, Action: p.Action, AppRoles: roles(p.AppRole)})
			return err
		}, nil
	case "node_thumbnail":
		return parseNodeThumbnail(e.Payload)
	case "step_started":
		return parseStepStarted(e.Payload)
	case "step_finished":
		return parseStepFinished(e.Payload)
	default:
		return nil, fmt.Errorf("unknown event type %q", e.Type)
	}
}

// parseNodeThumbnail attaches the screenshot of a screen, taken while exploring, to its node. The image is checked like
// any evidence: a key issued for this run, an object that exists, within the size limit, and an image type.
func parseNodeThumbnail(raw json.RawMessage) (func(context.Context, *graphWriter) error, error) {
	var p struct {
		Fingerprint string      `json:"fingerprint"`
		Artifact    artifactRef `json:"artifact"`
	}
	if err := strictDecode(raw, &p); err != nil {
		return nil, fmt.Errorf("node_thumbnail payload: %w", err)
	}
	if p.Fingerprint == "" || len(p.Fingerprint) > 200 {
		return nil, errors.New("node_thumbnail needs the fingerprint of the screen")
	}
	if p.Artifact.Kind != "screenshot" {
		return nil, errors.New("a thumbnail must be a screenshot")
	}
	if _, ok := artifactExt(p.Artifact.Kind, p.Artifact.ContentType); !ok || p.Artifact.StorageKey == "" {
		return nil, errors.New("thumbnail needs a supported content_type and a storage_key")
	}
	return func(ctx context.Context, g *graphWriter) error {
		node, err := g.q.GetNodeByFingerprint(ctx, graph.GetNodeByFingerprintParams{OrganizationID: g.orgID, GraphID: g.graph, Fingerprint: p.Fingerprint})
		if err != nil {
			return unknownNode(err, p.Fingerprint)
		}
		if _, err := g.verifyArtifact(ctx, p.Artifact.StorageKey); err != nil {
			return err
		}
		mt, _, _ := mime.ParseMediaType(p.Artifact.ContentType)
		return g.q.SetNodeThumbnail(ctx, graph.SetNodeThumbnailParams{OrganizationID: g.orgID, ID: node.ID, ThumbnailKey: &p.Artifact.StorageKey, ThumbnailContentType: &mt})
	}, nil
}

func parseStepStarted(raw json.RawMessage) (func(context.Context, *graphWriter) error, error) {
	var p struct {
		Key    string     `json:"key"`
		NodeID *uuid.UUID `json:"node_id"`
		// NodeFingerprint names the screen when the runner has no ids yet, as in an exploration.
		NodeFingerprint string          `json:"node_fingerprint"`
		Executor        string          `json:"executor"`
		Expected        string          `json:"expected"`
		Input           json.RawMessage `json:"input"`
		// Security marks the step as a security check; the finding it reports is a bug of its own kind.
		Security *stepSecurity `json:"security"`
	}
	if err := strictDecode(raw, &p); err != nil {
		return nil, fmt.Errorf("step_started payload: %w", err)
	}
	if p.NodeID != nil && p.NodeFingerprint != "" {
		return nil, errors.New("a step names its screen by node_id or by node_fingerprint, not both")
	}
	securityJSON, err := p.Security.validated()
	if err != nil {
		return nil, err
	}
	switch p.Executor {
	case "browser", "mobile_web", "api", "terminal":
	default:
		return nil, errors.New("executor must be browser, mobile_web, api or terminal")
	}
	if p.Key == "" || len(p.Key) > 200 || len(p.Expected) > 1000 {
		return nil, errors.New("step needs a key (max 200) and an expected text (max 1000)")
	}
	if len(p.Input) == 0 {
		p.Input = json.RawMessage(`{}`)
	}
	if !isJSONObject(p.Input) {
		return nil, errors.New("input must be an object")
	}
	input := step.MaskInput(p.Input)
	return func(ctx context.Context, g *graphWriter) error {
		node, err := g.stepNode(ctx, p.NodeID)
		if err != nil {
			return err
		}
		if p.NodeFingerprint != "" {
			n, err := g.q.GetNodeByFingerprint(ctx, graph.GetNodeByFingerprintParams{OrganizationID: g.orgID, GraphID: g.graph, Fingerprint: p.NodeFingerprint})
			if err != nil {
				return unknownNode(err, p.NodeFingerprint)
			}
			node = uuid.NullUUID{UUID: n.ID, Valid: true}
		}
		ex := p.Executor
		_, err = g.steps.UpsertStep(ctx, step.UpsertStepParams{
			OrganizationID: g.orgID, RunID: g.runID, ClientKey: p.Key, NodeID: node, Executor: &ex, InputMasked: input,
			Expected: p.Expected, StartedAt: now(), Security: securityJSON,
		})
		return err
	}, nil
}

// stepSecurity is what makes a step a security check.
type stepSecurity struct {
	Check    string `json:"check"`
	Severity string `json:"severity"`
	Scope    string `json:"scope,omitempty"`
}

var checkID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,39}$`)

// validated checks the shape and returns what is stored; nil (no security) is a plain functional step.
func (s *stepSecurity) validated() ([]byte, error) {
	if s == nil {
		return nil, nil
	}
	if !checkID.MatchString(s.Check) {
		return nil, errors.New("security.check must be a short id such as xss-reflected")
	}
	if s.Severity != "critical" && s.Severity != "high" && s.Severity != "normal" {
		return nil, errors.New("security.severity must be critical, high or normal")
	}
	if len(s.Scope) > 200 {
		return nil, errors.New("security.scope is too long")
	}
	return json.Marshal(s)
}

type artifactRef struct {
	Kind        string `json:"kind"`
	StorageKey  string `json:"storage_key"`
	ContentType string `json:"content_type"`
}

func parseStepFinished(raw json.RawMessage) (func(context.Context, *graphWriter) error, error) {
	var p struct {
		Key       string        `json:"key"`
		Result    string        `json:"result"`
		Actual    string        `json:"actual"`
		Artifacts []artifactRef `json:"artifacts"`
	}
	if err := strictDecode(raw, &p); err != nil {
		return nil, fmt.Errorf("step_finished payload: %w", err)
	}
	switch p.Result {
	case "pass", "fail", "error", "skipped":
	default:
		return nil, errors.New("result must be pass, fail, error or skipped")
	}
	if p.Key == "" || len(p.Key) > 200 || len(p.Actual) > 2000 || len(p.Artifacts) > maxStepArtifacts {
		return nil, errors.New("step_finished needs a key (max 200), actual (max 2000) and at most 10 artifacts")
	}
	for _, a := range p.Artifacts {
		if _, ok := artifactExt(a.Kind, a.ContentType); !ok || a.StorageKey == "" {
			return nil, errors.New("artifact needs a supported kind/content_type and a storage_key")
		}
	}
	return func(ctx context.Context, g *graphWriter) error {
		result := p.Result
		row, err := g.steps.UpsertStep(ctx, step.UpsertStepParams{
			OrganizationID: g.orgID, RunID: g.runID, ClientKey: p.Key, InputMasked: []byte(`{}`), Actual: p.Actual, Result: &result, FinishedAt: now(),
		})
		if err != nil {
			return err
		}
		if err := g.recordBugs(ctx, row, result, p.Actual); err != nil {
			return err
		}
		for _, a := range p.Artifacts {
			size, err := g.verifyArtifact(ctx, a.StorageKey)
			if err != nil {
				return err
			}
			mt, _, _ := mime.ParseMediaType(a.ContentType)
			if _, err := g.steps.CreateArtifact(ctx, step.CreateArtifactParams{
				OrganizationID: g.orgID, RunStepID: row.ID, Kind: a.Kind, StorageKey: a.StorageKey, ContentType: mt, Size: size,
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

// recordBugs lets a finished step open, recur, reopen or fix bugs of its node.
func (g *graphWriter) recordBugs(ctx context.Context, row step.RunStep, result, actual string) error {
	if !row.NodeID.Valid {
		return nil
	}
	n, err := g.q.GetNodeByID(ctx, graph.GetNodeByIDParams{OrganizationID: g.orgID, ID: row.NodeID.UUID})
	if err != nil {
		return err
	}
	in := bug.RecordInput{
		OrganizationID: g.orgID, ProjectID: g.projectID, RunID: g.runID, StepID: row.ID, NodeID: n.ID,
		NodeFingerprint: n.Fingerprint, NodeLabel: n.Label, Result: result, Actual: actual,
	}
	if len(row.Security) > 0 {
		var s stepSecurity
		if err := json.Unmarshal(row.Security, &s); err != nil {
			return fmt.Errorf("read the step's security check: %w", err)
		}
		in.Security = &bug.Security{Check: s.Check, Severity: s.Severity, Scope: s.Scope}
	}
	return bug.Record(ctx, g.bugs, in)
}

func now() pgtype.Timestamptz { return pgtype.Timestamptz{Time: time.Now(), Valid: true} }

// stepNode checks that a step only references nodes of the graph this run works on.
func (g *graphWriter) stepNode(ctx context.Context, id *uuid.UUID) (uuid.NullUUID, error) {
	if id == nil {
		return uuid.NullUUID{}, nil
	}
	n, err := g.q.GetNodeByID(ctx, graph.GetNodeByIDParams{OrganizationID: g.orgID, ID: *id})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && n.GraphID != g.graph) {
		return uuid.NullUUID{}, fmt.Errorf("%w: node %s is not part of this run's graph", errBadEvent, id)
	}
	if err != nil {
		return uuid.NullUUID{}, err
	}
	return uuid.NullUUID{UUID: n.ID, Valid: true}, nil
}

// verifyArtifact accepts only keys issued for this run and objects that really exist within the size limit.
// The size recorded comes from the store, never from the runner.
func (g *graphWriter) verifyArtifact(ctx context.Context, key string) (int64, error) {
	if g.storage == nil {
		return 0, errNoStorage
	}
	prefix := fmt.Sprintf("%s/%s/", g.orgID, g.runID)
	if !strings.HasPrefix(key, prefix) || path.Clean(key) != key {
		return 0, fmt.Errorf("%w: storage_key is not under this run", errBadEvent)
	}
	size, err := g.storage.Size(ctx, key)
	if err != nil {
		return 0, fmt.Errorf("%w: artifact was not uploaded", errBadEvent)
	}
	if size > maxArtifactBytes {
		_ = g.storage.Delete(ctx, key)
		return 0, fmt.Errorf("%w: artifact exceeds %d bytes", errBadEvent, maxArtifactBytes)
	}
	return size, nil
}

func unknownNode(err error, fp string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: unknown node fingerprint %q", errBadEvent, fp)
	}
	return err
}

// applyBatch stores every event and applies the new ones atomically; duplicates (same run, attempt, seq) are skipped.
func applyBatch(ctx context.Context, pool *pgxpool.Pool, store Storage, cur run.Run, evs []rawEvent, applies []func(context.Context, *graphWriter) error) error {
	if !cur.GraphID.Valid {
		return errors.New("run has no graph")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	rq := run.New(tx)
	gw := &graphWriter{q: graph.New(tx), steps: step.New(tx), bugs: bug.New(tx), storage: store, orgID: cur.OrganizationID, projectID: cur.ProjectID, runID: cur.ID, graph: cur.GraphID.UUID}
	for i, e := range evs {
		n, err := rq.InsertRunEvent(ctx, run.InsertRunEventParams{RunID: cur.ID, Attempt: cur.Attempts, Seq: e.Seq, Type: e.Type, Payload: e.Payload})
		if err != nil {
			return err
		}
		if n == 0 {
			continue
		}
		if err := applies[i](ctx, gw); err != nil {
			return err
		}
	}
	if err := events.Notify(ctx, tx, graph.NotifyChannel, cur.GraphID.UUID.String()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// regressionTargets turns the covered nodes of the graph into test targets. Nodes without a recorded URL
// cannot be revisited and are left out.
// coveredNode is a node with a requirement linked to it, and the keys of the requirements that count for this run.
type coveredNode struct {
	ID              uuid.UUID
	Kind            string
	Fingerprint     string
	Label           string
	AppRoles        []string
	Metadata        []byte
	RequirementKeys []string
}

// coveredNodes are the nodes a regression tests; when the run is limited to one spec, only the nodes (and the
// requirement keys) of that spec.
func coveredNodes(ctx context.Context, runs *run.Queries, org, graphID uuid.UUID, spec uuid.NullUUID) ([]coveredNode, error) {
	if spec.Valid {
		rows, err := runs.ListCoveredNodesForSpec(ctx, run.ListCoveredNodesForSpecParams{OrganizationID: org, GraphID: graphID, SpecID: spec.UUID})
		if err != nil {
			return nil, err
		}
		out := make([]coveredNode, 0, len(rows))
		for _, n := range rows {
			out = append(out, coveredNode(n))
		}
		return out, nil
	}
	rows, err := runs.ListCoveredNodes(ctx, run.ListCoveredNodesParams{OrganizationID: org, GraphID: graphID})
	if err != nil {
		return nil, err
	}
	out := make([]coveredNode, 0, len(rows))
	for _, n := range rows {
		out = append(out, coveredNode(n))
	}
	return out, nil
}

func regressionTargets(ctx context.Context, runs *run.Queries, org, graphID uuid.UUID, only []uuid.UUID, spec uuid.NullUUID) ([]jobTarget, error) {
	rows, err := coveredNodes(ctx, runs, org, graphID, spec)
	if err != nil {
		return nil, fmt.Errorf("list covered nodes: %w", err)
	}
	out := make([]jobTarget, 0, len(rows))
	restrict := make(map[uuid.UUID]bool, len(only))
	for _, id := range only {
		restrict[id] = true
	}
	for _, n := range rows {
		if len(restrict) > 0 && !restrict[n.ID] {
			continue
		}
		if n.Kind == "command" {
			var meta struct {
				Command struct {
					Args          []string `json:"args"`
					HelpSignature string   `json:"help_signature"`
				} `json:"command"`
			}
			if json.Unmarshal(n.Metadata, &meta) != nil {
				continue
			}
			out = append(out, jobTarget{Kind: "command", NodeID: n.ID, Fingerprint: n.Fingerprint, Label: n.Label, AppRole: "cli", RequirementKeys: n.RequirementKeys,
				Args: meta.Command.Args, HelpSignature: meta.Command.HelpSignature})
			continue
		}
		if n.Kind == "endpoint" {
			var meta struct {
				Operation openapi.Operation `json:"operation"`
			}
			if json.Unmarshal(n.Metadata, &meta) != nil || meta.Operation.Method == "" {
				continue
			}
			op := meta.Operation
			query := make(map[string]string, len(op.Query))
			for _, q := range op.Query {
				query[q.Name] = q.Example
			}
			out = append(out, jobTarget{Kind: "endpoint", NodeID: n.ID, Fingerprint: n.Fingerprint, Label: n.Label, AppRole: "api", RequirementKeys: n.RequirementKeys,
				Method: op.Method, Path: op.ConcretePath(), Query: query, Status: op.Status, Schema: op.Schema, BodyRequired: op.BodyNeeded})
			continue
		}
		var meta pageMeta
		_ = json.Unmarshal(n.Metadata, &meta)
		if meta.URL == "" {
			continue
		}
		role := ""
		if len(n.AppRoles) > 0 {
			role = n.AppRoles[0]
		}
		out = append(out, jobTarget{Kind: "page", NodeID: n.ID, Fingerprint: n.Fingerprint, URL: meta.URL, Label: n.Label, AppRole: role, RequirementKeys: n.RequirementKeys, Probes: meta.probes()})
	}
	return out, nil
}

// pageMeta is what a screen's node remembers that the regression needs.
type pageMeta struct {
	URL   string   `json:"url"`
	Query []string `json:"query"` // names of the parameters the screen was found with, never their values
	Forms []struct {
		Method string `json:"method"`
		Action string `json:"action"`
		Fields []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"fields"`
	} `json:"forms"`
}

const (
	maxProbesPerPage = 5
	maxProbeParams   = 5
)

// probes lists the reads a security check may try on the screen: its own address with the parameters it takes, and its
// search forms (GET). Forms that send data (POST...) are never probed from here, and neither is a form that goes to
// another host.
func (m pageMeta) probes() []jobProbe {
	base, err := url.Parse(m.URL)
	if err != nil {
		return nil
	}
	var out []jobProbe
	if params := capNames(m.Query); len(params) > 0 {
		out = append(out, jobProbe{URL: m.URL, Params: params})
	}
	for _, f := range m.Forms {
		if len(out) >= maxProbesPerPage {
			break
		}
		if !strings.EqualFold(f.Method, "GET") {
			continue
		}
		target, err := base.Parse(f.Action)
		if err != nil || target.Host != base.Host || target.Scheme != base.Scheme {
			continue
		}
		target.RawQuery, target.Fragment = "", ""
		var names []string
		for _, fld := range f.Fields {
			switch fld.Type {
			case "text", "search", "email", "url", "tel", "textarea", "":
				if fld.Name != "" {
					names = append(names, fld.Name)
				}
			}
		}
		if names = capNames(names); len(names) > 0 {
			out = append(out, jobProbe{URL: target.String(), Params: names})
		}
	}
	return out
}

func capNames(in []string) []string {
	if len(in) > maxProbeParams {
		in = in[:maxProbeParams]
	}
	return in
}

// ---- artifacts ----

const (
	artifactTTL      = 10 * time.Minute
	maxArtifactBytes = 20 << 20
	maxStepArtifacts = 10
)

// artifactTypes: what each kind of evidence may be. Evidence comes from the tested app, so the set is closed.
var artifactTypes = map[string]map[string]string{
	"screenshot": {"image/png": "png", "image/jpeg": "jpg"},
	"video":      {"video/webm": "webm"},
	"trace":      {"application/zip": "zip"},
	"har":        {"application/json": "har"},
	"console":    {"text/plain": "log"},
	"http":       {"application/json": "json"},
	"stdout":     {"text/plain": "txt"},
}

func artifactExt(kind, contentType string) (string, bool) {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return "", false
	}
	ext, ok := artifactTypes[kind][mt]
	return ext, ok
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func terminalOf(env environment.Environment) *jobTerminal {
	if env.Kind != "terminal" || env.TerminalBinary == nil {
		return nil
	}
	return &jobTerminal{Binary: *env.TerminalBinary, Image: deref(env.TerminalImage)}
}
