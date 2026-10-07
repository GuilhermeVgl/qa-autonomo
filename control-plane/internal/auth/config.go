package auth

import (
	"net/http"

	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

// ClientConfig is what the SPA needs to sign users in. Nothing secret: the client is public (PKCE).
type ClientConfig struct {
	Mode     string `json:"mode"` // "oidc" or "dev"
	Issuer   string `json:"issuer,omitempty"`
	ClientID string `json:"client_id,omitempty"`
}

// RegisterConfig mounts the public endpoint the web app reads at startup (runtime config, no rebuild per environment).
func RegisterConfig(mux *http.ServeMux, cfg ClientConfig) {
	mux.HandleFunc("GET /api/v1/auth/config", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, cfg)
	})
}
