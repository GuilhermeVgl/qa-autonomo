// Package graph persists and serves the application graph (nodes and edges per environment).
package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/events"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

// NotifyChannel is the Postgres channel that carries "graph changed" pings (payload = graph id).
const NotifyChannel = "graph_changed"

type graphInfo struct {
	ID            uuid.UUID  `json:"id"`
	EnvironmentID uuid.UUID  `json:"environment_id"`
	Version       int32      `json:"version"`
	SourceRunID   *uuid.UUID `json:"source_run_id"`
}

type nodeView struct {
	ID          uuid.UUID       `json:"id"`
	Kind        string          `json:"kind"`
	Fingerprint string          `json:"fingerprint"`
	Label       string          `json:"label"`
	AppRoles    []string        `json:"app_roles"`
	Metadata    json.RawMessage `json:"metadata"`
	// Requirements is how many requirements, of any spec, are linked to the node: above zero means it is covered.
	Requirements int32 `json:"requirement_count"`
	// RequirementKeys are the first requirements that cover the node, so a screen can say what it is for.
	RequirementKeys []string `json:"requirement_keys"`
	// HasThumbnail says the node has a screenshot, served by GET /nodes/{id}/thumbnail.
	HasThumbnail bool `json:"has_thumbnail"`
}

type edgeView struct {
	ID         uuid.UUID       `json:"id"`
	FromNodeID uuid.UUID       `json:"from_node_id"`
	ToNodeID   uuid.UUID       `json:"to_node_id"`
	Key        string          `json:"key"`
	Action     json.RawMessage `json:"action"`
	AppRoles   []string        `json:"app_roles"`
}

type fullView struct {
	Graph graphInfo  `json:"graph"`
	Nodes []nodeView `json:"nodes"`
	Edges []edgeView `json:"edges"`
}

// nodeStatus is what the last testing run said about a node. Status is the worst result: a screen whose page passed
// but whose form failed is failing.
type nodeStatus struct {
	NodeID  uuid.UUID `json:"node_id"`
	RunID   uuid.UUID `json:"run_id"`
	Status  string    `json:"status"`
	Passed  int32     `json:"passed"`
	Failed  int32     `json:"failed"`
	Errored int32     `json:"errored"`
	Skipped int32     `json:"skipped"`
	At      time.Time `json:"at"`
}

func toNodeStatus(r LatestNodeResultsRow) nodeStatus {
	status := "skipped"
	switch {
	case r.Failed > 0:
		status = "fail"
	case r.Errored > 0:
		status = "error"
	case r.Passed > 0:
		status = "pass"
	}
	return nodeStatus{NodeID: r.NodeID, RunID: r.RunID, Status: status, Passed: r.Passed, Failed: r.Failed, Errored: r.Errored, Skipped: r.Skipped, At: r.At.Time}
}

func info(g Graph) graphInfo {
	gi := graphInfo{ID: g.ID, EnvironmentID: g.EnvironmentID, Version: g.Version}
	if g.SourceRunID.Valid {
		gi.SourceRunID = &g.SourceRunID.UUID
	}
	return gi
}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool, hub *events.Hub) {
	q := New(pool)

	respond := func(w http.ResponseWriter, r *http.Request, g Graph, org uuid.UUID) {
		nodes, err := q.ListNodes(r.Context(), ListNodesParams{OrganizationID: org, GraphID: g.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		edges, err := q.ListEdges(r.Context(), ListEdgesParams{OrganizationID: org, GraphID: g.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		links, err := q.CountLinksByNode(r.Context(), CountLinksByNodeParams{OrganizationID: org, GraphID: g.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		linked := make(map[uuid.UUID]int32, len(links))
		keys := make(map[uuid.UUID][]string, len(links))
		for _, l := range links {
			linked[l.NodeID] = l.Requirements
			keys[l.NodeID] = l.Keys
		}
		v := fullView{Graph: info(g), Nodes: make([]nodeView, 0, len(nodes)), Edges: make([]edgeView, 0, len(edges))}
		for _, n := range nodes {
			v.Nodes = append(v.Nodes, nodeView{ID: n.ID, Kind: n.Kind, Fingerprint: n.Fingerprint, Label: n.Label, AppRoles: n.AppRoles, Metadata: n.Metadata, Requirements: linked[n.ID], RequirementKeys: append([]string{}, keys[n.ID]...), HasThumbnail: n.ThumbnailKey != nil})
		}
		for _, e := range edges {
			v.Edges = append(v.Edges, edgeView{ID: e.ID, FromNodeID: e.FromNodeID, ToNodeID: e.ToNodeID, Key: e.Key, Action: e.Action, AppRoles: e.AppRoles})
		}
		httpx.WriteJSON(w, http.StatusOK, v)
	}

	mux.Handle("GET /api/v1/graphs/{id}", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		g, ok := loadGraph(w, r, q, p.OrganizationID)
		if !ok {
			return
		}
		respond(w, r, g, p.OrganizationID)
	})))

	mux.Handle("GET /api/v1/environments/{id}/graph", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		eid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		g, err := q.GetLatestGraph(r.Context(), GetLatestGraphParams{OrganizationID: p.OrganizationID, EnvironmentID: eid})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		respond(w, r, g, p.OrganizationID)
	})))

	// What the tests said about each screen, for coloring the map: the verdict of the newest run that tested the node,
	// kept across graph versions (same fingerprint = same screen).
	mux.Handle("GET /api/v1/environments/{id}/node-status", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		g, err := q.GetLatestGraph(r.Context(), GetLatestGraphParams{OrganizationID: p.OrganizationID, EnvironmentID: eid})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteJSON(w, http.StatusOK, []nodeStatus{})
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		rows, err := q.LatestNodeResults(r.Context(), LatestNodeResultsParams{OrganizationID: p.OrganizationID, EnvironmentID: eid, GraphID: g.ID})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]nodeStatus, 0, len(rows))
		for _, row := range rows {
			out = append(out, toNodeStatus(row))
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	// SSE: sends "graph_changed" pings; the client refetches the graph. Simple and loses nothing.
	mux.Handle("GET /api/v1/graphs/{id}/stream", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		g, ok := loadGraph(w, r, q, p.OrganizationID)
		if !ok {
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			httpx.Error(w, http.StatusInternalServerError, "streaming unsupported")
			return
		}
		ch, unsubscribe := hub.Subscribe(g.ID.String())
		defer unsubscribe()
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		_, _ = fmt.Fprint(w, "event: ready\ndata: {}\n\n")
		flusher.Flush()
		keepalive := time.NewTicker(25 * time.Second)
		defer keepalive.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ch:
				_, _ = fmt.Fprint(w, "event: graph_changed\ndata: {}\n\n")
			case <-keepalive.C:
				_, _ = fmt.Fprint(w, ": keepalive\n\n")
			}
			flusher.Flush()
		}
	})))
}

func loadGraph(w http.ResponseWriter, r *http.Request, q *Queries, org uuid.UUID) (Graph, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not found")
		return Graph{}, false
	}
	g, err := q.GetGraph(r.Context(), GetGraphParams{OrganizationID: org, ID: id})
	if err != nil {
		notFoundOr500(w, err)
		return Graph{}, false
	}
	return g, true
}

func notFoundOr500(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not found")
		return
	}
	httpx.Error(w, http.StatusInternalServerError, "internal error")
}
