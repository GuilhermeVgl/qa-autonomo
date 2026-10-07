package llm

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewRecorder returns a usage recorder backed by llm_usage.
func NewRecorder(pool *pgxpool.Pool) func(context.Context, Usage) error {
	q := New(pool)
	return func(ctx context.Context, u Usage) error {
		return q.RecordUsage(ctx, RecordUsageParams(u))
	}
}
