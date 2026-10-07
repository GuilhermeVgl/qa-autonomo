package llm_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/org"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

func TestRecorder_PersistsUsage(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewPool(t)
	o, err := org.New(pool).EnsureOrganization(ctx, org.EnsureOrganizationParams{Name: "A", Slug: "a"})
	if err != nil {
		t.Fatal(err)
	}
	rec := llm.NewRecorder(pool)
	runID := uuid.New()
	if err := rec(ctx, llm.Usage{OrganizationID: o.ID, RunID: uuid.NullUUID{UUID: runID, Valid: true}, Task: "summarize", Provider: "p", Model: "m", TokensIn: 5, TokensOut: 6}); err != nil {
		t.Fatal(err)
	}
	rows, err := llm.New(pool).ListUsage(ctx, llm.ListUsageParams{OrganizationID: o.ID, Limit: 10})
	if err != nil || len(rows) != 1 || rows[0].TokensIn != 5 || rows[0].Task != "summarize" || !rows[0].RunID.Valid || rows[0].RunID.UUID != runID {
		t.Fatalf("rows = %+v, err = %v", rows, err)
	}
}
