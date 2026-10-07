package auth_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
)

func TestAuthConfigEndpoint_IsPublicAndExposesOnlyClientSettings(t *testing.T) {
	mux := http.NewServeMux()
	auth.RegisterConfig(mux, auth.ClientConfig{Mode: "oidc", Issuer: "https://login.example/tenant/v2.0", ClientID: "abc"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/auth/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"mode": "oidc", "issuer": "https://login.example/tenant/v2.0", "client_id": "abc"}
	if len(got) != len(want) {
		t.Fatalf("unexpected fields: %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}
