// Package autospec writes the project's default spec by itself: one requirement per screen and per form that the
// exploration found, linked to the nodes they describe. Nothing here needs an LLM, so it works offline and is
// refreshed after every exploration.
package autospec

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/pendency"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
)

// Title is the name of the generated spec; the environment's name follows it. An environment has one: it is refreshed, not duplicated.
const Title = "Varredura automática"

// ErrNoMap means there is nothing to describe yet: the environment has no explored screens.
var ErrNoMap = errors.New("the environment has no explored screens yet")

const (
	maxRequirements  = 1500
	maxKeyLen        = 180
	maxSummaryLen    = 200
	maxActionsListed = 5
)

// Result tells what a generation changed.
type Result struct {
	SpecID    uuid.UUID `json:"spec_id"`
	Version   int32     `json:"version"`
	Created   int       `json:"created"`
	Updated   int       `json:"updated"`
	Unchanged int       `json:"unchanged"`
	Removed   int       `json:"removed"`
	Linked    int       `json:"linked"`
	// IsNew is true when this generation created the spec itself.
	IsNew bool `json:"-"`
}

// item is a requirement to generate and the nodes it describes.
type item struct {
	key, text, criticality string
	nodes                  []uuid.UUID
}

type formField struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	Type     string `json:"type"`
	Required bool   `json:"required"`
}

type formMeta struct {
	Label  string      `json:"label"`
	Method string      `json:"method"`
	Action string      `json:"action"`
	Fields []formField `json:"fields"`
}

// pageMeta is the part of a page node's metadata the sweep reads (written by the runner's interactive exploration).
type pageMeta struct {
	Title    string     `json:"title"`
	Summary  string     `json:"summary"`
	Forms    []formMeta `json:"forms"`
	Controls []struct {
		Label string `json:"label"`
	} `json:"controls"`
}

func (f formMeta) hasPassword() bool {
	return slices.ContainsFunc(f.Fields, func(x formField) bool { return x.Type == "password" })
}

// fieldName is how a person calls a field: its label, else its name.
func (x formField) fieldName() string {
	if l := oneLine(x.Label); l != "" {
		return l
	}
	return x.Name
}

// requiredFields are the visible fields the agent fills that the form insists on. A file field is never filled, so a form
// that needs one is left out of what can be checked.
func (f formMeta) requiredFields() []string {
	var out []string
	for _, x := range f.Fields {
		if x.Required && !slices.Contains([]string{"hidden", "submit", "button", "file"}, x.Type) {
			out = append(out, x.fieldName())
		}
	}
	return out
}

func (f formMeta) fieldList() string {
	var out []string
	for _, x := range f.Fields {
		if slices.Contains([]string{"hidden", "submit", "button"}, x.Type) {
			continue
		}
		n := x.fieldName()
		if x.Required {
			n += "*"
		}
		out = append(out, n)
	}
	if len(out) > 8 {
		out = append(out[:8], "…")
	}
	return strings.Join(out, ", ")
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func cut(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// screen is one route as the users saw it: the nodes of every user that reached it.
type screen struct {
	label string
	nodes []graph.Node
	users []string
}

func (s *screen) meta() pageMeta {
	// the node that knows most: one with controls, else one with a title or summary, else the first
	var best pageMeta
	for i, n := range s.nodes {
		var m pageMeta
		_ = json.Unmarshal(n.Metadata, &m)
		if i == 0 || len(m.Controls) > len(best.Controls) || (len(best.Controls) == 0 && best.Summary == "" && (m.Summary != "" || m.Title != "")) {
			best = m
		}
	}
	return best
}

// pageText says what the check is and what the agent saw, in the words a person would use to review it.
func pageText(s *screen, allUsers []string) string {
	m := s.meta()
	text := fmt.Sprintf("A tela %s responde sem erro (HTTP < 400) e mantém a estrutura mapeada.", s.label)
	if t := oneLine(m.Title); t != "" && t != s.label {
		text += fmt.Sprintf(" Título: %s.", cut(t, 80))
	}
	// the runner's mechanical summary ("Tela /x — ...") only repeats the route; a model's reading is worth keeping
	if sum := oneLine(m.Summary); sum != "" && !strings.HasPrefix(sum, "Tela ") {
		text += " " + cut(sum, maxSummaryLen)
	}
	var actions []string
	for _, c := range m.Controls {
		if l := oneLine(c.Label); l != "" && !slices.Contains(actions, l) {
			actions = append(actions, l)
		}
		if len(actions) == maxActionsListed {
			break
		}
	}
	if len(actions) > 0 {
		text += " Ações vistas: " + strings.Join(actions, ", ") + "."
	}
	if len(allUsers) > 1 {
		text += " Usuários: " + strings.Join(s.users, ", ") + "."
		if len(s.users) < len(allUsers) {
			text += " Só alcançada por: " + strings.Join(s.users, ", ") + "."
		}
	}
	return text
}

// buildItems turns the explored screens into requirements. It is deterministic: the same map gives the same spec.
func buildItems(nodes []graph.Node) []item {
	var order []*screen
	byLabel := map[string]*screen{}
	userSet := map[string]bool{}
	for _, n := range nodes {
		if n.Kind != "page" {
			continue // modals and observed endpoints are part of the map, but a spec line for them would have no check
		}
		sc := byLabel[n.Label]
		if sc == nil {
			sc = &screen{label: n.Label}
			byLabel[n.Label] = sc
			order = append(order, sc)
		}
		sc.nodes = append(sc.nodes, n)
		for _, u := range n.AppRoles {
			userSet[u] = true
			if !slices.Contains(sc.users, u) {
				sc.users = append(sc.users, u)
			}
		}
	}
	allUsers := make([]string, 0, len(userSet))
	for u := range userSet {
		allUsers = append(allUsers, u)
	}
	slices.Sort(allUsers)

	byKey := map[string]*item{}
	add := func(key, text, criticality string, ids []uuid.UUID) {
		key = cut(key, maxKeyLen)
		if it, ok := byKey[key]; ok {
			for _, id := range ids {
				if !slices.Contains(it.nodes, id) {
					it.nodes = append(it.nodes, id)
				}
			}
			return
		}
		byKey[key] = &item{key: key, text: text, criticality: criticality, nodes: slices.Clone(ids)}
	}

	for _, sc := range order {
		slices.Sort(sc.users)
		ids := make([]uuid.UUID, 0, len(sc.nodes))
		for _, n := range sc.nodes {
			ids = append(ids, n.ID)
		}
		add("PAGE "+sc.label, pageText(sc, allUsers), "normal", ids)

		seenForm := map[string]bool{}
		for _, n := range sc.nodes {
			var m pageMeta
			_ = json.Unmarshal(n.Metadata, &m)
			for _, f := range m.Forms {
				method := strings.ToUpper(strings.TrimSpace(f.Method))
				action := strings.TrimSpace(f.Action)
				if action == "" || !strings.HasPrefix(action, "/") || f.hasPassword() || seenForm[method+" "+action] {
					continue // passwords are never typed by the agent: login and account forms are not part of the sweep
				}
				seenForm[method+" "+action] = true
				label := cut(oneLine(f.Label), 80)
				if label == "" {
					label = action
				}
				fields := ""
				if list := f.fieldList(); list != "" {
					fields = " Campos: " + list + "."
				}
				if method == "GET" {
					add("FORM GET "+action, fmt.Sprintf("A busca ou filtro %q (GET %s) devolve uma tela sem erro.%s", label, action, fields), "normal", ids)
					continue
				}
				if method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" {
					continue
				}
				add(fmt.Sprintf("FORM %s %s", method, action), fmt.Sprintf("O formulário %q (%s %s) aceita dados válidos e é processado sem erro.%s", label, method, action, fields), "high", ids)
				// what a form must refuse is as much its behavior as what it accepts
				if required := f.requiredFields(); method != "DELETE" && len(required) > 0 {
					add(fmt.Sprintf("VALIDATE %s %s", method, action),
						fmt.Sprintf("O formulário %q (%s %s) não aceita o envio sem os campos obrigatórios (%s) e mostra o que falta, sem gravar nada.", label, method, action, strings.Join(required, ", ")), "normal", ids)
				}
			}
		}
	}
	out := make([]item, 0, len(byKey))
	for _, it := range byKey {
		out = append(out, *it)
	}
	slices.SortFunc(out, func(a, b item) int { return strings.Compare(a.key, b.key) })
	if len(out) > maxRequirements {
		out = out[:maxRequirements]
	}
	return out
}

// Generate writes (or refreshes) the project's automatic spec from the latest map of the environment. Requirements
// whose text did not change keep their identity, results and bugs; the ones that disappeared from the map are removed.
func Generate(ctx context.Context, pool *pgxpool.Pool, org uuid.UUID, actor string, env environment.Environment) (Result, error) {
	g, err := graph.New(pool).GetLatestGraph(ctx, graph.GetLatestGraphParams{OrganizationID: org, EnvironmentID: env.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{}, ErrNoMap
	}
	if err != nil {
		return Result{}, err
	}
	nodes, err := graph.New(pool).ListNodes(ctx, graph.ListNodesParams{OrganizationID: org, GraphID: g.ID})
	if err != nil {
		return Result{}, err
	}
	items := buildItems(nodes)
	if len(items) == 0 {
		return Result{}, ErrNoMap
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	sq, pq := spec.New(tx), pendency.New(tx)

	res := Result{}
	sp, err := sq.GetLatestAutoSpec(ctx, spec.GetLatestAutoSpecParams{OrganizationID: org, EnvironmentID: uuid.NullUUID{UUID: env.ID, Valid: true}})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		version, err := sq.NextSpecVersion(ctx, spec.NextSpecVersionParams{OrganizationID: org, ProjectID: env.ProjectID})
		if err != nil {
			return Result{}, err
		}
		sp, err = sq.CreateSpec(ctx, spec.CreateSpecParams{OrganizationID: org, ProjectID: env.ProjectID, Version: version, SourceType: "auto", Title: Title + " · " + env.Name, ExtractedText: "Gerada automaticamente a partir do mapa do ambiente " + env.Name + ".", EnvironmentID: uuid.NullUUID{UUID: env.ID, Valid: true}})
		if err != nil {
			return Result{}, err
		}
		res.IsNew = true
	case err != nil:
		return Result{}, err
	}
	res.SpecID, res.Version = sp.ID, sp.Version

	existing, err := sq.ListRequirements(ctx, spec.ListRequirementsParams{OrganizationID: org, SpecID: sp.ID})
	if err != nil {
		return Result{}, err
	}
	byKey := make(map[string]spec.Requirement, len(existing))
	for _, r := range existing {
		byKey[r.Key] = r
	}
	if err := sq.DeleteAgentLinksOfSpec(ctx, spec.DeleteAgentLinksOfSpecParams{OrganizationID: org, SpecID: sp.ID}); err != nil {
		return Result{}, err
	}

	keep := make(map[string]bool, len(items))
	for _, it := range items {
		keep[it.key] = true
		cur, found := byKey[it.key]
		var id uuid.UUID
		switch {
		case !found:
			row, err := sq.CreateRequirement(ctx, spec.CreateRequirementParams{OrganizationID: org, SpecID: sp.ID, Key: it.key, Text: it.text, Criticality: it.criticality, Status: "new"})
			if err != nil {
				return Result{}, err
			}
			id = row.ID
			res.Created++
		case cur.Text != it.text || cur.Criticality != it.criticality:
			if _, err := sq.UpdateRequirement(ctx, spec.UpdateRequirementParams{OrganizationID: org, ID: cur.ID, Text: it.text, Criticality: it.criticality, Status: "changed"}); err != nil {
				return Result{}, err
			}
			id = cur.ID
			res.Updated++
		default:
			if cur.Status != "unchanged" {
				if _, err := sq.UpdateRequirement(ctx, spec.UpdateRequirementParams{OrganizationID: org, ID: cur.ID, Text: cur.Text, Criticality: cur.Criticality, Status: "unchanged"}); err != nil {
					return Result{}, err
				}
			}
			id = cur.ID
			res.Unchanged++
		}
		for _, node := range it.nodes {
			if err := pq.UpsertLink(ctx, pendency.UpsertLinkParams{OrganizationID: org, RequirementID: id, NodeID: node, Confidence: 1, Source: "agent"}); err != nil {
				return Result{}, err
			}
			res.Linked++
		}
	}
	for key, r := range byKey {
		if keep[key] {
			continue
		}
		for _, del := range []func() error{
			func() error {
				return sq.DeleteLinksOfRequirement(ctx, spec.DeleteLinksOfRequirementParams{OrganizationID: org, RequirementID: r.ID})
			},
			func() error {
				return sq.DeletePendenciesOfRequirement(ctx, spec.DeletePendenciesOfRequirementParams{OrganizationID: org, RequirementID: r.ID})
			},
			func() error {
				return sq.DetachBugsFromRequirement(ctx, spec.DetachBugsFromRequirementParams{OrganizationID: org, RequirementID: uuid.NullUUID{UUID: r.ID, Valid: true}})
			},
			func() error {
				return sq.DeleteRequirement(ctx, spec.DeleteRequirementParams{OrganizationID: org, ID: r.ID})
			},
		} {
			if err := del(); err != nil {
				return Result{}, err
			}
		}
		res.Removed++
	}
	if err := sq.TouchSpec(ctx, spec.TouchSpecParams{OrganizationID: org, ID: sp.ID}); err != nil {
		return Result{}, err
	}

	payload, _ := json.Marshal(map[string]any{"environment_id": env.ID, "graph_id": g.ID, "created": res.Created, "updated": res.Updated, "removed": res.Removed})
	if err := audit.New(tx).RecordAudit(ctx, audit.RecordAuditParams{OrganizationID: org, Actor: actor, Action: "spec.auto", Target: sp.ID.String(), Payload: payload}); err != nil {
		return Result{}, err
	}
	return res, tx.Commit(ctx)
}

// Refresh regenerates the automatic spec after an exploration. It is best-effort: the run already finished, so a
// failure here is logged by the caller and never fails the run.
func Refresh(ctx context.Context, pool *pgxpool.Pool, org, envID uuid.UUID) error {
	env, err := environment.New(pool).GetEnvironment(ctx, environment.GetEnvironmentParams{OrganizationID: org, ID: envID})
	if err != nil {
		return fmt.Errorf("load environment: %w", err)
	}
	if _, err := Generate(ctx, pool, org, "system", env); err != nil && !errors.Is(err, ErrNoMap) {
		return fmt.Errorf("generate automatic spec: %w", err)
	}
	return nil
}

// Register mounts the endpoint that (re)generates the automatic spec of an environment.
func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	envs := environment.New(pool)
	mux.Handle("POST /api/v1/environments/{id}/specs/auto", mw(auth.RequireWriter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		env, err := envs.GetEnvironment(r.Context(), environment.GetEnvironmentParams{OrganizationID: p.OrganizationID, ID: eid})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		res, err := Generate(r.Context(), pool, p.OrganizationID, p.UserID.String(), env)
		if errors.Is(err, ErrNoMap) {
			httpx.Error(w, http.StatusConflict, "explore the application first: there are no screens to describe")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		status := http.StatusOK
		if res.IsNew {
			status = http.StatusCreated
		}
		httpx.WriteJSON(w, status, res)
	}))))
}
