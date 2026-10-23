// Package capture drives a remote browser the person uses to log in once, so the runner can grab the authenticated session
// (Playwright storageState) and reuse it. The browser runs in the runner; its screen is streamed to the web UI as JPEG
// frames (SSE) and the UI's clicks and keystrokes come back as input events (HTTP). This is how the agent gets past any
// SSO/2FA/captcha without a login flow.
//
// The live state lives in memory (single control-plane instance, as in the compose deployment); only the result — the
// encrypted `session` credential — is persisted. Multi-instance (SaaS) would need sticky routing or a shared transport.
package capture

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/secret"
)

// How long a capture may stay open before it is given up on, and how big a single frame may be.
const (
	sessionTTL   = 10 * time.Minute
	maxFrameSize = 2 << 20 // 2 MiB
)

var ErrNotFound = errors.New("capture session not found")

// Statuses a capture session moves through.
const (
	StatusPending  = "pending"
	StatusActive   = "active"
	StatusDone     = "done"
	StatusFailed   = "failed"
	StatusCanceled = "canceled"
)

// Input is one thing the person did in the remote browser. Coordinates are normalized (0..1) so the runner maps them to
// whatever viewport it uses.
type Input struct {
	Type   string  `json:"type"` // move | click | wheel | key | text
	X      float64 `json:"x,omitempty"`
	Y      float64 `json:"y,omitempty"`
	Button string  `json:"button,omitempty"`
	DeltaY float64 `json:"dy,omitempty"`
	Key    string  `json:"key,omitempty"`
	Text   string  `json:"text,omitempty"`
}

type session struct {
	id        uuid.UUID
	orgID     uuid.UUID
	envID     uuid.UUID
	appRole   string
	startURL  string
	createdBy uuid.UUID
	createdAt time.Time

	mu        sync.Mutex
	status    string
	runnerID  uuid.UUID
	frameSubs map[chan []byte]struct{}
	lastFrame []byte // base64 JPEG, ready for SSE
	inbox     []Input
	finish    bool
	cancel    bool
	sig       chan struct{} // coalescing wake-up for the runner's poll
	doneCh    chan struct{} // closed when the session reaches a terminal status
}

// Hub holds the live capture sessions and persists the captured session credential on completion.
type Hub struct {
	mu       sync.Mutex
	sessions map[uuid.UUID]*session
	pool     *pgxpool.Pool
	box      *secret.Box
}

func NewHub(pool *pgxpool.Pool, box *secret.Box) *Hub {
	return &Hub{sessions: map[uuid.UUID]*session{}, pool: pool, box: box}
}

// View is what the UI shows about a session.
type View struct {
	ID       uuid.UUID `json:"id"`
	Status   string    `json:"status"`
	AppRole  string    `json:"app_role"`
	StartURL string    `json:"start_url"`
}

func (s *session) view() View {
	return View{ID: s.id, Status: s.status, AppRole: s.appRole, StartURL: s.startURL}
}

// Create opens a pending capture session a runner can lease.
func (h *Hub) Create(orgID, envID, createdBy uuid.UUID, appRole, startURL string) View {
	s := &session{
		id: uuid.New(), orgID: orgID, envID: envID, appRole: appRole, startURL: startURL, createdBy: createdBy,
		createdAt: time.Now(), status: StatusPending, frameSubs: map[chan []byte]struct{}{},
		sig: make(chan struct{}, 1), doneCh: make(chan struct{}),
	}
	h.mu.Lock()
	// Only one open capture per organization at a time: a new one supersedes stale pending/active sessions
	// that could leave the UI forever waiting for a runner.
	for _, old := range h.sessions {
		if old.orgID != orgID {
			continue
		}
		old.mu.Lock()
		open := old.status == StatusPending || old.status == StatusActive
		if open {
			old.cancel = true
		}
		old.mu.Unlock()
		if open {
			old.terminal(StatusCanceled)
		}
	}
	h.sessions[s.id] = s
	h.mu.Unlock()
	return s.view()
}

func (h *Hub) get(id, orgID uuid.UUID) (*session, bool) {
	h.mu.Lock()
	s, ok := h.sessions[id]
	h.mu.Unlock()
	if !ok || s.orgID != orgID {
		return nil, false
	}
	return s, true
}

// Status returns the current view of a session.
func (h *Hub) Status(id, orgID uuid.UUID) (View, bool) {
	s, ok := h.get(id, orgID)
	if !ok {
		return View{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.view(), true
}

func (s *session) wake() {
	select {
	case s.sig <- struct{}{}:
	default:
	}
}

// terminal moves the session to a final status once; returns false if it was already terminal.
func (s *session) terminal(status string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == StatusDone || s.status == StatusFailed || s.status == StatusCanceled {
		return false
	}
	s.status = status
	close(s.doneCh)
	s.wake()
	return true
}

/* ---------- UI side ---------- */

// Subscribe adds an SSE listener and replays the last frame. The returned channel receives base64 JPEG frames; doneCh
// closes when the session ends.
func (h *Hub) Subscribe(id, orgID uuid.UUID) (frames <-chan []byte, done <-chan struct{}, replay []byte, unsubscribe func(), ok bool) {
	s, found := h.get(id, orgID)
	if !found {
		return nil, nil, nil, nil, false
	}
	ch := make(chan []byte, 2)
	s.mu.Lock()
	s.frameSubs[ch] = struct{}{}
	last := s.lastFrame
	s.mu.Unlock()
	return ch, s.doneCh, last, func() {
		s.mu.Lock()
		delete(s.frameSubs, ch)
		s.mu.Unlock()
	}, true
}

// Enqueue adds input events from the UI for the runner to apply.
func (h *Hub) Enqueue(id, orgID uuid.UUID, events []Input) bool {
	s, ok := h.get(id, orgID)
	if !ok {
		return false
	}
	s.mu.Lock()
	s.inbox = append(s.inbox, events...)
	s.mu.Unlock()
	s.wake()
	return true
}

// Finish asks the runner to capture the session and upload it.
func (h *Hub) Finish(id, orgID uuid.UUID) bool {
	s, ok := h.get(id, orgID)
	if !ok {
		return false
	}
	s.mu.Lock()
	s.finish = true
	s.mu.Unlock()
	s.wake()
	return true
}

// Cancel ends a capture without saving.
func (h *Hub) Cancel(id, orgID uuid.UUID) bool {
	s, ok := h.get(id, orgID)
	if !ok {
		return false
	}
	s.mu.Lock()
	s.cancel = true
	s.mu.Unlock()
	s.wake()
	s.terminal(StatusCanceled)
	return true
}

/* ---------- runner side ---------- */

// Lease hands a pending session to a runner of the same organization, long-polling until one appears or the deadline.
func (h *Hub) Lease(ctx context.Context, orgID, runnerID uuid.UUID, wait time.Duration) (View, bool) {
	deadline := time.Now().Add(wait)
	for {
		h.mu.Lock()
		for _, s := range h.sessions {
			s.mu.Lock()
			if s.orgID == orgID && s.status == StatusPending {
				s.status = StatusActive
				s.runnerID = runnerID
				v := s.view()
				s.mu.Unlock()
				h.mu.Unlock()
				return v, true
			}
			s.mu.Unlock()
		}
		h.mu.Unlock()
		if !time.Now().Add(250 * time.Millisecond).Before(deadline) {
			return View{}, false
		}
		select {
		case <-time.After(250 * time.Millisecond):
		case <-ctx.Done():
			return View{}, false
		}
	}
}

func (h *Hub) runnerSession(id, orgID, runnerID uuid.UUID) (*session, bool) {
	s, ok := h.get(id, orgID)
	if !ok {
		return nil, false
	}
	s.mu.Lock()
	bound := s.runnerID == runnerID
	s.mu.Unlock()
	if !bound {
		return nil, false
	}
	return s, true
}

// PushFrame broadcasts a JPEG frame (raw bytes) to the UI listeners; it is base64-encoded once here for SSE.
func (h *Hub) PushFrame(id, orgID, runnerID uuid.UUID, jpeg []byte) bool {
	s, ok := h.runnerSession(id, orgID, runnerID)
	if !ok || len(jpeg) == 0 || len(jpeg) > maxFrameSize {
		return ok && len(jpeg) <= maxFrameSize // an empty frame is not an error, just ignored
	}
	enc := []byte(base64.StdEncoding.EncodeToString(jpeg))
	s.mu.Lock()
	s.lastFrame = enc
	subs := make([]chan []byte, 0, len(s.frameSubs))
	for ch := range s.frameSubs {
		subs = append(subs, ch)
	}
	s.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- enc:
		default: // the UI is behind: drop this frame, the next one supersedes it
		}
	}
	return true
}

// Poll returns the queued input and control flags for the runner, long-polling until something happens or the deadline.
func (h *Hub) Poll(ctx context.Context, id, orgID, runnerID uuid.UUID, wait time.Duration) (events []Input, finish, cancel, ok bool) {
	s, found := h.runnerSession(id, orgID, runnerID)
	if !found {
		return nil, false, true, false
	}
	deadline := time.Now().Add(wait)
	for {
		s.mu.Lock()
		if len(s.inbox) > 0 || s.finish || s.cancel {
			events, finish, cancel = s.inbox, s.finish, s.cancel
			s.inbox = nil
			s.mu.Unlock()
			return events, finish, cancel, true
		}
		s.mu.Unlock()
		if !time.Now().Before(deadline) {
			return nil, false, false, true
		}
		select {
		case <-s.sig:
		case <-time.After(time.Until(deadline)):
		case <-ctx.Done():
			return nil, false, false, true
		}
	}
}

// Result stores the captured storageState as an encrypted `session` credential and ends the session.
func (h *Hub) Result(ctx context.Context, id, orgID, runnerID uuid.UUID, state string) error {
	s, ok := h.runnerSession(id, orgID, runnerID)
	if !ok {
		return ErrNotFound
	}
	plain, _ := json.Marshal(map[string]string{"state": state})
	sealed, err := h.box.Seal(plain)
	if err != nil {
		return err
	}
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	if _, err := environment.New(tx).UpsertCredential(ctx, environment.UpsertCredentialParams{
		OrganizationID: orgID, EnvironmentID: s.envID, AppRole: s.appRole, Kind: "session", PayloadEncrypted: sealed,
	}); err != nil {
		return err
	}
	auditPayload, _ := json.Marshal(map[string]string{"app_role": s.appRole, "kind": "session", "via": "capture"}) // never the session
	if err := audit.New(tx).RecordAudit(ctx, audit.RecordAuditParams{
		OrganizationID: orgID, Actor: s.createdBy.String(), Action: "credential.upsert", Target: s.envID.String(), Payload: auditPayload,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.terminal(StatusDone)
	return nil
}

// Fail ends a session the runner could not complete.
func (h *Hub) Fail(id, orgID, runnerID uuid.UUID) bool {
	s, ok := h.runnerSession(id, orgID, runnerID)
	if !ok {
		return false
	}
	return s.terminal(StatusFailed)
}

// Run expires sessions that have been open too long and drops finished ones, until ctx ends.
func (h *Hub) Run(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.sweep()
		}
	}
}

func (h *Hub) sweep() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, s := range h.sessions {
		s.mu.Lock()
		terminal := s.status == StatusDone || s.status == StatusFailed || s.status == StatusCanceled
		old := time.Since(s.createdAt) > sessionTTL
		s.mu.Unlock()
		if old && !terminal {
			s.cancel = true
			s.terminal(StatusCanceled)
		}
		// keep terminal sessions briefly so the UI can read the final status, then drop
		if terminal && time.Since(s.createdAt) > sessionTTL+time.Minute {
			delete(h.sessions, id)
		}
	}
}
