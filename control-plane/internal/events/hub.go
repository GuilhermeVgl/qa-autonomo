// Package events fans Postgres LISTEN/NOTIFY out to in-process subscribers (feeds SSE).
// It works with several server instances because every instance LISTENs on its own.
package events

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Hub struct {
	pool    *pgxpool.Pool
	channel string
	ready   chan struct{}
	once    sync.Once

	mu   sync.Mutex
	subs map[string]map[chan struct{}]struct{}
}

func NewHub(pool *pgxpool.Pool, channel string) *Hub {
	return &Hub{pool: pool, channel: channel, ready: make(chan struct{}), subs: map[string]map[chan struct{}]struct{}{}}
}

// Ready is closed once the first LISTEN is active.
func (h *Hub) Ready() <-chan struct{} { return h.ready }

// Subscribe returns a coalescing channel (capacity 1) that fires whenever key is notified.
func (h *Hub) Subscribe(key string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	if h.subs[key] == nil {
		h.subs[key] = map[chan struct{}]struct{}{}
	}
	h.subs[key][ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(h.subs[key], ch)
		if len(h.subs[key]) == 0 {
			delete(h.subs, key)
		}
	}
}

func (h *Hub) dispatch(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[key] {
		select {
		case ch <- struct{}{}:
		default: // already pending: coalesce
		}
	}
}

// Run listens until ctx ends, reconnecting with a short backoff on errors.
func (h *Hub) Run(ctx context.Context) error {
	for ctx.Err() == nil {
		if err := h.listen(ctx); err != nil && ctx.Err() == nil {
			select {
			case <-time.After(time.Second):
			case <-ctx.Done():
			}
		}
	}
	return ctx.Err()
}

func (h *Hub) listen(ctx context.Context) error {
	conn, err := h.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire listen conn: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{h.channel}.Sanitize()); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	h.once.Do(func() { close(h.ready) })
	for {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait notification: %w", err)
		}
		h.dispatch(n.Payload)
	}
}

// Notify sends key on channel. Inside a transaction it is delivered only on commit.
func Notify(ctx context.Context, db interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}, channel, key string) error {
	if _, err := db.Exec(ctx, "SELECT pg_notify($1, $2)", channel, key); err != nil {
		return fmt.Errorf("notify %s: %w", channel, err)
	}
	return nil
}
