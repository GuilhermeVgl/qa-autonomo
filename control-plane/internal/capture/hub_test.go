package capture

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHub_LeaseInputFramesAndControl(t *testing.T) {
	h := NewHub(nil, nil) // Result is the only method that needs pool/box; not exercised here
	ctx := context.Background()
	org, runner, user, env := uuid.New(), uuid.New(), uuid.New(), uuid.New()

	v := h.Create(org, env, user, "admin", "https://a.com")
	if v.Status != StatusPending || v.StartURL != "https://a.com" {
		t.Fatalf("create = %+v", v)
	}
	// a different organization cannot see the session
	if _, ok := h.Status(v.ID, uuid.New()); ok {
		t.Fatal("cross-org Status must fail")
	}

	// the runner leases it and it becomes active and bound
	got, ok := h.Lease(ctx, org, runner, time.Second)
	if !ok || got.ID != v.ID || got.Status != StatusActive {
		t.Fatalf("lease = %+v ok=%v", got, ok)
	}
	// a second runner of the same org finds nothing pending
	if _, ok := h.Lease(ctx, org, uuid.New(), 100*time.Millisecond); ok {
		t.Fatal("already-active session must not be leased again")
	}

	// UI input reaches the runner's poll
	h.Enqueue(v.ID, org, []Input{{Type: "click", X: 0.5, Y: 0.5}})
	events, finish, cancel, ok := h.Poll(ctx, v.ID, org, runner, time.Second)
	if !ok || len(events) != 1 || events[0].Type != "click" || finish || cancel {
		t.Fatalf("poll = %+v finish=%v cancel=%v ok=%v", events, finish, cancel, ok)
	}
	// a poll from the wrong runner is rejected
	if _, _, _, ok := h.Poll(ctx, v.ID, org, uuid.New(), 100*time.Millisecond); ok {
		t.Fatal("poll from the wrong runner must fail")
	}

	// frames from the runner reach a UI subscriber (base64-encoded)
	frames, done, replay, unsub, ok := h.Subscribe(v.ID, org)
	if !ok || replay != nil {
		t.Fatalf("subscribe ok=%v replay=%v", ok, replay)
	}
	defer unsub()
	if !h.PushFrame(v.ID, org, runner, []byte{0xFF, 0xD8, 0xFF, 0xD9}) {
		t.Fatal("push frame failed")
	}
	select {
	case f := <-frames:
		if string(f) != "/9j/2Q==" {
			t.Errorf("frame = %q", f)
		}
	case <-time.After(time.Second):
		t.Fatal("no frame delivered")
	}

	// finish is reported to the runner's next poll
	h.Finish(v.ID, org)
	_, finish, _, _ = h.Poll(ctx, v.ID, org, runner, time.Second)
	if !finish {
		t.Error("finish flag not delivered")
	}

	// cancel ends the session and closes the done channel
	h.Cancel(v.ID, org)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Error("done not closed on cancel")
	}
	if v2, _ := h.Status(v.ID, org); v2.Status != StatusCanceled {
		t.Errorf("status = %s, want canceled", v2.Status)
	}
}

func TestHub_LeaseTimesOutWhenNothingPending(t *testing.T) {
	h := NewHub(nil, nil)
	if _, ok := h.Lease(context.Background(), uuid.New(), uuid.New(), 100*time.Millisecond); ok {
		t.Fatal("lease with no pending session must time out")
	}
}

func TestHub_CreateCancelsPreviousOpenSession(t *testing.T) {
	h := NewHub(nil, nil)
	ctx := context.Background()
	org, runner, user, env := uuid.New(), uuid.New(), uuid.New(), uuid.New()

	first := h.Create(org, env, user, "admin", "https://a.com")
	if _, ok := h.Lease(ctx, org, runner, time.Second); !ok {
		t.Fatal("first lease failed")
	}
	second := h.Create(org, env, user, "admin", "https://a.com")

	v, ok := h.Status(first.ID, org)
	if !ok || v.Status != StatusCanceled {
		t.Fatalf("first status = %+v ok=%v, want canceled", v, ok)
	}
	leased, ok := h.Lease(ctx, org, runner, time.Second)
	if !ok || leased.ID != second.ID {
		t.Fatalf("leased = %+v ok=%v, want second session", leased, ok)
	}
}
