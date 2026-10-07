package auth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
)

// fakeIdP is a minimal OIDC provider: discovery + JWKS + a token signer.
type fakeIdP struct {
	issuer string
	sign   func(claims map[string]any) string
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwk := jose.JSONWebKey{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": srv.URL, "jwks_uri": srv.URL + "/keys",
			"authorization_endpoint": srv.URL + "/authorize", "token_endpoint": srv.URL + "/token",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{jwk}})
	})
	signWith := func(k *rsa.PrivateKey) func(map[string]any) string {
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: k, KeyID: "k1"}}, (&jose.SignerOptions{}).WithType("JWT"))
		if err != nil {
			t.Fatal(err)
		}
		return func(claims map[string]any) string {
			tok, err := jwt.Signed(signer).Claims(claims).Serialize()
			if err != nil {
				t.Fatal(err)
			}
			return tok
		}
	}
	return &fakeIdP{issuer: srv.URL, sign: signWith(key)}
}

func (i *fakeIdP) claims(extra map[string]any) map[string]any {
	c := map[string]any{"iss": i.issuer, "aud": "client-1", "sub": "user-1", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix()}
	for k, v := range extra {
		c[k] = v
	}
	return c
}

func TestOIDCVerifier(t *testing.T) {
	idp := newFakeIdP(t)
	v, err := auth.NewOIDCVerifier(context.Background(), idp.issuer, "client-1")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	t.Run("valid token yields subject and email", func(t *testing.T) {
		id, err := v.Verify(ctx, idp.sign(idp.claims(map[string]any{"email": "ana@kpmg.com"})))
		if err != nil || id.Subject != "user-1" || id.Email != "ana@kpmg.com" {
			t.Fatalf("got %+v, %v", id, err)
		}
	})

	t.Run("falls back to preferred_username then upn (Entra ID)", func(t *testing.T) {
		id, err := v.Verify(ctx, idp.sign(idp.claims(map[string]any{"preferred_username": "ana@kpmg.com"})))
		if err != nil || id.Email != "ana@kpmg.com" {
			t.Fatalf("preferred_username: %+v, %v", id, err)
		}
		id, err = v.Verify(ctx, idp.sign(idp.claims(map[string]any{"upn": "bia@kpmg.com"})))
		if err != nil || id.Email != "bia@kpmg.com" {
			t.Fatalf("upn: %+v, %v", id, err)
		}
	})

	t.Run("rejects invalid tokens", func(t *testing.T) {
		other := newFakeIdP(t) // same kid, different key and issuer
		cases := map[string]string{
			"no email-like claim": idp.sign(idp.claims(nil)),
			"wrong audience":      idp.sign(idp.claims(map[string]any{"aud": "other", "email": "a@x.com"})),
			"expired":             idp.sign(idp.claims(map[string]any{"exp": time.Now().Add(-time.Hour).Unix(), "email": "a@x.com"})),
			"wrong issuer":        idp.sign(idp.claims(map[string]any{"iss": "https://evil", "email": "a@x.com"})),
			"foreign signature":   other.sign(idp.claims(map[string]any{"email": "a@x.com"})),
			"garbage":             "not.a.jwt",
		}
		for name, tok := range cases {
			if _, err := v.Verify(ctx, tok); err == nil {
				t.Errorf("%s: token accepted", name)
			}
		}
	})
}
