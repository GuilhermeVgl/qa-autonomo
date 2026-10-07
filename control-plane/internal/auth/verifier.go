package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

var (
	ErrUnknownUser  = errors.New("unknown user")
	ErrInvalidToken = errors.New("invalid token")
)

// Verifier validates a bearer token and returns the caller identity.
type Verifier interface {
	Verify(ctx context.Context, token string) (Identity, error)
}

// OIDCVerifier validates ID tokens issued by the configured OIDC provider (Entra ID at KPMG).
type OIDCVerifier struct{ v *oidc.IDTokenVerifier }

func NewOIDCVerifier(ctx context.Context, issuer, clientID string) (*OIDCVerifier, error) {
	p, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	return &OIDCVerifier{v: p.Verifier(&oidc.Config{ClientID: clientID})}, nil
}

func (o *OIDCVerifier) Verify(ctx context.Context, token string) (Identity, error) {
	t, err := o.v.Verify(ctx, token)
	if err != nil {
		return Identity{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	var claims struct {
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
		UPN               string `json:"upn"`
	}
	if err := t.Claims(&claims); err != nil {
		return Identity{}, fmt.Errorf("%w: claims: %v", ErrInvalidToken, err)
	}
	// Entra ID often omits `email`; preferred_username/upn carry the user's address.
	for _, e := range []string{claims.Email, claims.PreferredUsername, claims.UPN} {
		if strings.Contains(e, "@") {
			return Identity{Subject: t.Subject, Email: e}, nil
		}
	}
	return Identity{}, fmt.Errorf("%w: token has no email, preferred_username or upn", ErrInvalidToken)
}

// DevVerifier accepts "dev:<email>" tokens. Local users exist ONLY in dev (AUTH_MODE=dev).
type DevVerifier struct{}

func (DevVerifier) Verify(_ context.Context, token string) (Identity, error) {
	email, ok := strings.CutPrefix(token, "dev:")
	if !ok || !strings.Contains(email, "@") {
		return Identity{}, ErrInvalidToken
	}
	return Identity{Subject: token, Email: email}, nil
}
