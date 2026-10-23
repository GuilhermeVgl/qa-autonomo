// Package environment manages application environments and their encrypted credentials.
package environment

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/secret"
)

type envView struct {
	ID                uuid.UUID `json:"id"`
	ProjectID         uuid.UUID `json:"project_id"`
	Name              string    `json:"name"`
	BaseURL           string    `json:"base_url"`
	AllowedHosts      []string  `json:"allowed_hosts"`
	DestructivePolicy string    `json:"destructive_policy"`
	IsProduction      bool      `json:"is_production"`
	Device            *string   `json:"device"`
	Kind              string    `json:"kind"`
	Binary            *string   `json:"binary"`
	Image             *string   `json:"image"`
}

func toView(e Environment) envView {
	return envView{ID: e.ID, ProjectID: e.ProjectID, Name: e.Name, BaseURL: e.BaseUrl,
		AllowedHosts: e.AllowedHosts, DestructivePolicy: e.DestructivePolicy, IsProduction: e.IsProduction, Device: e.Device, Kind: e.Kind, Binary: e.TerminalBinary, Image: e.TerminalImage}
}

// SupportedDevices are the Playwright device descriptors an environment may emulate (executor mobile_web).
var SupportedDevices = map[string]bool{
	"iPhone 13": true, "iPhone 14": true, "Pixel 5": true, "Pixel 7": true, "iPad Pro 11": true, "Galaxy S9+": true,
}

type createInput struct {
	Name              string   `json:"name"`
	BaseURL           string   `json:"base_url"`
	AllowedHosts      []string `json:"allowed_hosts"`
	DestructivePolicy string   `json:"destructive_policy"`
	IsProduction      bool     `json:"is_production"`
	Device            *string  `json:"device"`
	Kind              string   `json:"kind"`   // web (default) | terminal
	Binary            *string  `json:"binary"` // terminal: the CLI under test
	Image             *string  `json:"image"`  // terminal: image of the ephemeral runner that carries the CLI
}

// normalize validates the input and fills defaults: allowed_hosts = [base host], policy = block.
func (in *createInput) normalize() error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return errors.New("name is required")
	}
	switch in.Kind {
	case "", "web":
		in.Kind = "web"
		if in.Binary != nil || in.Image != nil {
			return errors.New("binary and image are only for terminal environments")
		}
	case "terminal":
		return in.normalizeTerminal()
	default:
		return errors.New("kind must be web or terminal")
	}
	u, err := url.Parse(in.BaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return errors.New("base_url must be an http(s) URL")
	}
	if len(in.AllowedHosts) == 0 {
		in.AllowedHosts = []string{u.Hostname()}
	}
	for i, h := range in.AllowedHosts {
		in.AllowedHosts[i] = strings.ToLower(strings.TrimSpace(h))
		if in.AllowedHosts[i] == "" {
			return errors.New("allowed_hosts must not contain empty entries")
		}
	}
	if in.Device != nil {
		d := strings.TrimSpace(*in.Device)
		if !SupportedDevices[d] {
			return errors.New("device is not supported (see the list of emulated devices)")
		}
		in.Device = &d
	}
	switch in.DestructivePolicy {
	case "":
		in.DestructivePolicy = "block"
	case "block", "confirm", "allow":
	default:
		return errors.New("destructive_policy must be block, confirm or allow")
	}
	return nil
}

var (
	binaryRe = regexp.MustCompile(`^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$`) // no spaces, shell characters or leading "-"
	imageRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,299}$`)
)

// normalizeTerminal validates a terminal environment: the CLI runs inside the ephemeral runner container, with no
// network, so there is no URL and no allowed hosts.
func (in *createInput) normalizeTerminal() error {
	if in.Binary == nil || !binaryRe.MatchString(strings.TrimSpace(*in.Binary)) {
		return errors.New("binary is required (a command name or path, without spaces or shell characters)")
	}
	b := strings.TrimSpace(*in.Binary)
	in.Binary = &b
	if in.Image != nil {
		img := strings.TrimSpace(*in.Image)
		if !imageRe.MatchString(img) {
			return errors.New("image must look like an image reference, e.g. registry.example/cli:1.0")
		}
		in.Image = &img
	}
	if in.Device != nil {
		return errors.New("device is only for web environments")
	}
	in.BaseURL = "terminal://" + b
	in.AllowedHosts = []string{}
	switch in.DestructivePolicy {
	case "":
		in.DestructivePolicy = "block"
	case "block", "confirm", "allow":
	default:
		return errors.New("destructive_policy must be block, confirm or allow")
	}
	return nil
}

type credentialInput struct {
	AppRole string            `json:"app_role"`
	Kind    string            `json:"kind"`
	Payload map[string]string `json:"payload"`
}

func (in *credentialInput) validate() error {
	in.AppRole = strings.TrimSpace(in.AppRole)
	if in.AppRole == "" {
		return errors.New("app_role is required")
	}
	var required []string
	switch in.Kind {
	case "login":
		required = []string{"username"} // a senha é opcional: SSO/magic-link e fluxos de primeira etapa só pedem o usuário
	case "api_token":
		required = []string{"token"}
	case "session":
		required = []string{"state"} // a Playwright storageState JSON captured by `npm run capture`
	default:
		return errors.New("kind must be login, api_token or session")
	}
	for _, k := range required {
		if in.Payload[k] == "" {
			return errors.New("payload." + k + " is required for kind " + in.Kind)
		}
	}
	return nil
}

type credView struct {
	ID      uuid.UUID `json:"id"`
	AppRole string    `json:"app_role"`
	Kind    string    `json:"kind"`
}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool, box *secret.Box) {
	q := New(pool)
	projects := project.New(pool)
	write := func(h http.HandlerFunc) http.Handler { return mw(auth.RequireWriter(h)) }

	mux.Handle("POST /api/v1/projects/{id}/environments", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		pid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in createInput
		if !httpx.Decode(w, r, &in) {
			return
		}
		if err := in.normalize(); err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		if _, err := projects.GetProject(r.Context(), project.GetProjectParams{OrganizationID: p.OrganizationID, ID: pid}); err != nil {
			notFoundOr500(w, err)
			return
		}
		row, err := q.CreateEnvironment(r.Context(), CreateEnvironmentParams{
			OrganizationID: p.OrganizationID, ProjectID: pid, Name: in.Name, BaseUrl: in.BaseURL,
			AllowedHosts: in.AllowedHosts, DestructivePolicy: in.DestructivePolicy, IsProduction: in.IsProduction, Device: in.Device, Kind: in.Kind, TerminalBinary: in.Binary, TerminalImage: in.Image,
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, toView(row))
	}))

	mux.Handle("GET /api/v1/projects/{id}/environments", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		pid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListEnvironments(r.Context(), ListEnvironmentsParams{OrganizationID: p.OrganizationID, ProjectID: pid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]envView, 0, len(rows))
		for _, row := range rows {
			out = append(out, toView(row))
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("PUT /api/v1/environments/{id}/credentials", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in credentialInput
		if !httpx.Decode(w, r, &in) {
			return
		}
		if err := in.validate(); err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		if _, err := q.GetEnvironment(r.Context(), GetEnvironmentParams{OrganizationID: p.OrganizationID, ID: eid}); err != nil {
			notFoundOr500(w, err)
			return
		}
		plain, _ := json.Marshal(in.Payload)
		sealed, err := box.Seal(plain)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		tx, err := pool.Begin(r.Context())
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer tx.Rollback(r.Context()) //nolint:errcheck // no-op after commit
		row, err := New(tx).UpsertCredential(r.Context(), UpsertCredentialParams{
			OrganizationID: p.OrganizationID, EnvironmentID: eid, AppRole: in.AppRole, Kind: in.Kind, PayloadEncrypted: sealed,
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		auditPayload, _ := json.Marshal(map[string]string{"app_role": in.AppRole, "kind": in.Kind}) // never the secret
		if err := audit.New(tx).RecordAudit(r.Context(), audit.RecordAuditParams{
			OrganizationID: p.OrganizationID, Actor: p.UserID.String(), Action: "credential.upsert",
			Target: eid.String(), Payload: auditPayload,
		}); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, credView{ID: row.ID, AppRole: row.AppRole, Kind: row.Kind})
	}))

	mux.Handle("GET /api/v1/environments/{id}/credentials", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListCredentials(r.Context(), ListCredentialsParams{OrganizationID: p.OrganizationID, EnvironmentID: eid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]credView, 0, len(rows))
		for _, row := range rows {
			out = append(out, credView{ID: row.ID, AppRole: row.AppRole, Kind: row.Kind})
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("DELETE /api/v1/credentials/{id}", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		cid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		tx, err := pool.Begin(r.Context())
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		defer tx.Rollback(r.Context()) //nolint:errcheck // no-op after commit
		n, err := New(tx).DeleteCredential(r.Context(), DeleteCredentialParams{OrganizationID: p.OrganizationID, ID: cid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if n == 0 {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		auditPayload, _ := json.Marshal(map[string]string{"credential_id": cid.String()})
		if err := audit.New(tx).RecordAudit(r.Context(), audit.RecordAuditParams{
			OrganizationID: p.OrganizationID, Actor: p.UserID.String(), Action: "credential.delete", Target: cid.String(), Payload: auditPayload,
		}); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
}

func notFoundOr500(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not found")
		return
	}
	httpx.Error(w, http.StatusInternalServerError, "internal error")
}
