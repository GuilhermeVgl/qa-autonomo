package auth_test

import (
	"context"
	"testing"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/org"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

func TestLogin_FirstUserIsOwnerNextIsMemberAndIsAudited(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewPool(t)
	o, err := org.New(pool).EnsureOrganization(ctx, org.EnsureOrganizationParams{Name: "KPMG", Slug: "kpmg"})
	if err != nil {
		t.Fatalf("ensure org: %v", err)
	}
	svc := auth.NewService(pool, o.ID)

	first, err := svc.Login(ctx, auth.Identity{Subject: "s1", Email: "a@x.com"})
	if err != nil {
		t.Fatalf("login 1: %v", err)
	}
	if first.Role != "owner" {
		t.Errorf("first role = %q, want owner", first.Role)
	}
	second, err := svc.Login(ctx, auth.Identity{Subject: "s2", Email: "b@x.com"})
	if err != nil {
		t.Fatalf("login 2: %v", err)
	}
	if second.Role != "member" {
		t.Errorf("second role = %q, want member", second.Role)
	}
	again, err := svc.Login(ctx, auth.Identity{Subject: "s1", Email: "a@x.com"})
	if err != nil || again.Role != "owner" || again.UserID != first.UserID {
		t.Errorf("relogin = %+v, %v; want same owner", again, err)
	}

	got, err := svc.Principal(ctx, auth.Identity{Subject: "s2"})
	if err != nil || got.Email != "b@x.com" {
		t.Errorf("principal = %+v, %v", got, err)
	}
	if _, err := svc.Principal(ctx, auth.Identity{Subject: "unknown"}); err == nil {
		t.Error("expected error for unknown subject")
	}

	entries, err := audit.New(pool).ListAudit(ctx, audit.ListAuditParams{OrganizationID: o.ID, Limit: 10})
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	if len(entries) != 3 || entries[0].Action != "login" {
		t.Errorf("audit entries = %d (%v), want 3 login", len(entries), entries)
	}
}

func TestPrincipal_IsolatedByOrganization(t *testing.T) {
	ctx := context.Background()
	pool := testutil.NewPool(t)
	orgs := org.New(pool)
	a, _ := orgs.EnsureOrganization(ctx, org.EnsureOrganizationParams{Name: "A", Slug: "a"})
	b, _ := orgs.EnsureOrganization(ctx, org.EnsureOrganizationParams{Name: "B", Slug: "b"})
	if _, err := auth.NewService(pool, a.ID).Login(ctx, auth.Identity{Subject: "s", Email: "u@a.com"}); err != nil {
		t.Fatal(err)
	}
	if _, err := auth.NewService(pool, b.ID).Principal(ctx, auth.Identity{Subject: "s"}); err == nil {
		t.Fatal("user from org A must not resolve in org B")
	}
}
