// Package auth authenticates users (OIDC; local users only in dev) and resolves principals.
package auth

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
)

// Identity is what a Verifier extracts from a valid token.
type Identity struct {
	Subject string
	Email   string
}

// Principal is an authenticated user within one organization.
type Principal struct {
	UserID         uuid.UUID `json:"user_id"`
	OrganizationID uuid.UUID `json:"organization_id"`
	Email          string    `json:"email"`
	Role           string    `json:"role"`
}

type Service struct {
	pool  *pgxpool.Pool
	orgID uuid.UUID
}

func NewService(pool *pgxpool.Pool, orgID uuid.UUID) *Service {
	return &Service{pool: pool, orgID: orgID}
}

// Login provisions the user and membership on first access and records an audit entry.
// The first member of an organization becomes its owner.
func (s *Service) Login(ctx context.Context, id Identity) (Principal, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Principal{}, fmt.Errorf("begin login: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	q := New(tx)
	u, err := q.UpsertUser(ctx, UpsertUserParams{OrganizationID: s.orgID, Email: id.Email, OidcSubject: id.Subject})
	if err != nil {
		return Principal{}, fmt.Errorf("upsert user: %w", err)
	}
	if err := q.EnsureMembership(ctx, EnsureMembershipParams{OrganizationID: s.orgID, UserID: u.ID}); err != nil {
		return Principal{}, fmt.Errorf("ensure membership: %w", err)
	}
	payload, _ := json.Marshal(map[string]string{"email": id.Email})
	if err := audit.New(tx).RecordAudit(ctx, audit.RecordAuditParams{
		OrganizationID: s.orgID, Actor: u.ID.String(), Action: "login", Target: u.ID.String(), Payload: payload,
	}); err != nil {
		return Principal{}, fmt.Errorf("record audit: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Principal{}, fmt.Errorf("commit login: %w", err)
	}
	return s.Principal(ctx, id)
}

// Principal resolves an already provisioned user; it returns an error if the user never logged in.
func (s *Service) Principal(ctx context.Context, id Identity) (Principal, error) {
	row, err := New(s.pool).GetPrincipalBySubject(ctx, GetPrincipalBySubjectParams{OrganizationID: s.orgID, OidcSubject: id.Subject})
	if err != nil {
		if err == pgx.ErrNoRows {
			return Principal{}, ErrUnknownUser
		}
		return Principal{}, fmt.Errorf("get principal: %w", err)
	}
	return Principal(row), nil
}
