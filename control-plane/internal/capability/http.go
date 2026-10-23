// Package capability groups mapped screens into business capabilities.
package capability

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

type nodeView struct {
	ID      uuid.UUID `json:"id"`
	Label   string    `json:"label"`
	Covered bool      `json:"covered"`
	Status  string    `json:"status"`
}

type capabilityView struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Description  string     `json:"description"`
	Criticality  string     `json:"criticality"`
	Source       string     `json:"source"`
	NodesTotal   int        `json:"nodes_total"`
	NodesCovered int        `json:"nodes_covered"`
	NodesTested  int        `json:"nodes_tested"`
	Status       string     `json:"status"`
	Nodes        []nodeView `json:"nodes"`
}

type response struct {
	GraphID      uuid.UUID        `json:"graph_id"`
	GeneratedAt  time.Time        `json:"generated_at"`
	Capabilities []capabilityView `json:"capabilities"`
}

type accumulator struct {
	nodes []nodeView
}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	q := graph.New(pool)

	build := func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if _, err := environment.New(pool).GetEnvironment(r.Context(), environment.GetEnvironmentParams{OrganizationID: p.OrganizationID, ID: eid}); err != nil {
			notFoundOr500(w, err)
			return
		}
		g, err := q.GetLatestGraph(r.Context(), graph.GetLatestGraphParams{OrganizationID: p.OrganizationID, EnvironmentID: eid})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusConflict, "no graph for this environment yet")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}

		nodes, err := q.ListNodes(r.Context(), graph.ListNodesParams{OrganizationID: p.OrganizationID, GraphID: g.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		links, err := q.CountLinksByNode(r.Context(), graph.CountLinksByNodeParams{OrganizationID: p.OrganizationID, GraphID: g.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		latest, err := q.LatestNodeResults(r.Context(), graph.LatestNodeResultsParams{OrganizationID: p.OrganizationID, EnvironmentID: eid, GraphID: g.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}

		covered := map[uuid.UUID]bool{}
		for _, l := range links {
			if l.Requirements > 0 {
				covered[l.NodeID] = true
			}
		}
		verdict := map[uuid.UUID]string{}
		for _, row := range latest {
			verdict[row.NodeID] = statusOf(row)
		}

		grouped := map[string]*accumulator{}
		for _, n := range nodes {
			if n.Kind != "page" {
				continue
			}
			key := capabilityKey(n.Label)
			if grouped[key] == nil {
				grouped[key] = &accumulator{}
			}
			grouped[key].nodes = append(grouped[key].nodes, nodeView{
				ID:      n.ID,
				Label:   n.Label,
				Covered: covered[n.ID],
				Status:  nodeStatus(verdict[n.ID]),
			})
		}

		out := make([]capabilityView, 0, len(grouped))
		keys := make([]string, 0, len(grouped))
		for k := range grouped {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		for _, k := range keys {
			nodes := grouped[k].nodes
			sort.Slice(nodes, func(i, j int) bool { return nodes[i].Label < nodes[j].Label })
			coveredN := 0
			tested := 0
			status := "untested"
			for _, n := range nodes {
				if n.Covered {
					coveredN++
				}
				if n.Status != "untested" {
					tested++
				}
				status = worst(status, n.Status)
			}
			out = append(out, capabilityView{
				ID:           k,
				Name:         capabilityName(k),
				Description:  fmt.Sprintf("Telas do mapa no domínio %q.", k),
				Criticality:  "normal",
				Source:       "agent",
				NodesTotal:   len(nodes),
				NodesCovered: coveredN,
				NodesTested:  tested,
				Status:       status,
				Nodes:        nodes,
			})
		}

		httpx.WriteJSON(w, http.StatusOK, response{GraphID: g.ID, GeneratedAt: time.Now().UTC(), Capabilities: out})
	}

	mux.Handle("GET /api/v1/environments/{id}/capabilities", mw(http.HandlerFunc(build)))
	mux.Handle("POST /api/v1/environments/{id}/capabilities", mw(auth.RequireWriter(http.HandlerFunc(build))))
}

func capabilityKey(route string) string {
	s := strings.TrimSpace(route)
	if s == "" || s == "/" {
		return "home"
	}
	s = strings.TrimPrefix(s, "/")
	if s == "" {
		return "home"
	}
	seg := strings.Split(s, "/")[0]
	seg = strings.TrimSpace(seg)
	if seg == "" {
		return "home"
	}
	return strings.ToLower(seg)
}

func capabilityName(key string) string {
	if key == "home" {
		return "Entrada e navegação"
	}
	return strings.ToUpper(key[:1]) + key[1:]
}

func statusOf(r graph.LatestNodeResultsRow) string {
	if r.Failed > 0 {
		return "fail"
	}
	if r.Errored > 0 {
		return "error"
	}
	if r.Passed > 0 {
		return "pass"
	}
	return "skipped"
}

func nodeStatus(s string) string {
	if s == "" {
		return "untested"
	}
	return s
}

func rank(s string) int {
	switch s {
	case "fail":
		return 5
	case "error":
		return 4
	case "pass":
		return 3
	case "skipped":
		return 2
	default:
		return 1
	}
}

func worst(a, b string) string {
	if rank(b) > rank(a) {
		return b
	}
	return a
}

func notFoundOr500(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not found")
		return
	}
	httpx.Error(w, http.StatusInternalServerError, "internal error")
}
