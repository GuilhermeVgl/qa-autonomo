package events_test

import (
	"context"
	"testing"
	"time"

	"github.com/kpmg/agent-qa/control-plane/internal/events"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

func TestHub_DeliversNotificationsPerKey(t *testing.T) {
	pool := testutil.NewPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub := events.NewHub(pool, "graph_changed")
	go func() { _ = hub.Run(ctx) }()
	select {
	case <-hub.Ready():
	case <-time.After(10 * time.Second):
		t.Fatal("hub never started listening")
	}

	a, unsubA := hub.Subscribe("graph-a")
	defer unsubA()
	b, unsubB := hub.Subscribe("graph-b")
	defer unsubB()

	if err := events.Notify(ctx, pool, "graph_changed", "graph-a"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a:
	case <-time.After(5 * time.Second):
		t.Fatal("subscriber a not notified")
	}
	select {
	case <-b:
		t.Fatal("subscriber b must not be notified for graph-a")
	case <-time.After(300 * time.Millisecond):
	}

	unsubA()
	// notifying after unsubscribe must not panic or block
	if err := events.Notify(ctx, pool, "graph_changed", "graph-a"); err != nil {
		t.Fatal(err)
	}
}
