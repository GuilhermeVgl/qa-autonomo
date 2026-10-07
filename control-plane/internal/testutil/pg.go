// Package testutil provides a real Postgres (testcontainers) for tests.
package testutil

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcminio "github.com/testcontainers/testcontainers-go/modules/minio"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/kpmg/agent-qa/control-plane/internal/database"
	"github.com/kpmg/agent-qa/control-plane/internal/storage"
)

// NewPool starts a throwaway PostgreSQL 18, applies migrations and returns a pool.
func NewPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	ctr, err := tcpostgres.Run(ctx, "postgres:18-alpine",
		tcpostgres.WithDatabase("qa"), tcpostgres.WithUsername("qa"), tcpostgres.WithPassword("qa"),
		tcpostgres.BasicWaitStrategies(),
		testcontainers.WithWaitStrategy(wait.ForListeningPort("5432/tcp")),
	)
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(ctr) })
	url, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatalf("connection string: %v", err)
	}
	pool, err := database.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}

// NewMinio starts a throwaway MinIO and returns a config for storage.NewS3 (bucket not yet created).
func NewMinio(t *testing.T) storage.S3Config {
	t.Helper()
	ctx := context.Background()
	ctr, err := tcminio.Run(ctx, "quay.io/minio/minio:latest", tcminio.WithUsername("minioadmin"), tcminio.WithPassword("minioadmin"))
	if err != nil {
		t.Fatalf("start minio: %v", err)
	}
	t.Cleanup(func() { _ = testcontainers.TerminateContainer(ctr) })
	endpoint, err := ctr.ConnectionString(ctx)
	if err != nil {
		t.Fatalf("minio endpoint: %v", err)
	}
	return storage.S3Config{Endpoint: endpoint, AccessKey: "minioadmin", SecretKey: "minioadmin", Bucket: "evidence"}
}
