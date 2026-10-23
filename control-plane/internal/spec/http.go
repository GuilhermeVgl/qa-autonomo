package spec

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
	"github.com/kpmg/agent-qa/control-plane/internal/openapi"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
)

type specView struct {
	ID         uuid.UUID `json:"id"`
	ProjectID  uuid.UUID `json:"project_id"`
	Version    int32     `json:"version"`
	SourceType string    `json:"source_type"`
	Title      string    `json:"title"`
	// EnvironmentID is set for the automatic spec: it describes the map of that environment.
	EnvironmentID *uuid.UUID `json:"environment_id,omitempty"`
}

func toSpecView(s Spec) specView {
	v := specView{ID: s.ID, ProjectID: s.ProjectID, Version: s.Version, SourceType: s.SourceType, Title: s.Title}
	if s.EnvironmentID.Valid {
		v.EnvironmentID = &s.EnvironmentID.UUID
	}
	return v
}

func itemsOf(rows []Requirement) []Item {
	out := make([]Item, 0, len(rows))
	for _, r := range rows {
		out = append(out, Item{Key: r.Key, Text: r.Text, Criticality: r.Criticality, Status: r.Status})
	}
	return out
}

// Register mounts the spec endpoints. extractor may be nil when no LLM is configured (503).
func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool, extractor Extractor) {
	q := New(pool)
	projects := project.New(pool)

	mux.Handle("POST /api/v1/projects/{id}/specs", mw(auth.RequireWriter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		pid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		var in struct {
			Title      string `json:"title"`
			SourceType string `json:"source_type"`
			Text       string `json:"text"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		in.Title = strings.TrimSpace(in.Title)
		switch {
		case in.Title == "" || strings.TrimSpace(in.Text) == "":
			httpx.Error(w, http.StatusBadRequest, "title and text are required")
			return
		case in.SourceType != "text" && in.SourceType != "openapi":
			httpx.Error(w, http.StatusBadRequest, "source_type must be text or openapi (documents are not supported yet)")
			return
		}
		if _, err := projects.GetProject(r.Context(), project.GetProjectParams{OrganizationID: p.OrganizationID, ID: pid}); err != nil {
			notFoundOr500(w, err)
			return
		}
		if in.SourceType == "text" && extractor == nil {
			httpx.Error(w, http.StatusServiceUnavailable, "LLM is not configured")
			return
		}

		var previous []Item
		if latest, err := q.GetLatestSpec(r.Context(), GetLatestSpecParams{OrganizationID: p.OrganizationID, ProjectID: pid}); err == nil {
			rows, err := q.ListRequirements(r.Context(), ListRequirementsParams{OrganizationID: p.OrganizationID, SpecID: latest.ID})
			if err != nil {
				httpx.Error(w, http.StatusInternalServerError, "internal error")
				return
			}
			previous = itemsOf(rows)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}

		var extracted []Item
		var doc openapi.Doc
		var attach func(context.Context, pgx.Tx, map[string]uuid.UUID) error
		if in.SourceType == "openapi" {
			// deterministic: contract requirements and endpoint nodes come straight from the document, no LLM
			doc, err = openapi.Parse([]byte(in.Text))
			if err != nil {
				httpx.Error(w, http.StatusBadRequest, err.Error())
				return
			}
			extracted = make([]Item, 0, len(doc.Operations))
			for _, op := range doc.Operations {
				extracted = append(extracted, Item{Key: op.Key(), Text: op.RequirementText(), Criticality: op.Criticality()})
			}
			attach = func(ctx context.Context, tx pgx.Tx, reqs map[string]uuid.UUID) error {
				return attachEndpoints(ctx, tx, p.OrganizationID, pid, doc.Operations, reqs)
			}
		} else {
			extracted, err = extractor.Extract(r.Context(), p.OrganizationID, in.Text, previous)
			if err != nil {
				httpx.Error(w, http.StatusBadGateway, "requirement extraction failed")
				return
			}
		}
		marked, removed := Diff(previous, extracted)

		s, err := store(r.Context(), pool, p.OrganizationID, pid, in.SourceType, in.Title, in.Text, marked, attach)
		if errors.Is(err, errVersionConflict) {
			httpx.Error(w, http.StatusConflict, "another spec version was created concurrently, retry")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if removed == nil {
			removed = []Item{}
		}
		resp := map[string]any{"spec": toSpecView(s), "requirements": marked, "removed": removed}
		if in.SourceType == "openapi" {
			skipped := doc.Skipped
			if skipped == nil {
				skipped = []string{}
			}
			resp["skipped"] = skipped
		}
		httpx.WriteJSON(w, http.StatusCreated, resp)
	}))))

	mux.Handle("GET /api/v1/projects/{id}/specs", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		pid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListSpecs(r.Context(), ListSpecsParams{OrganizationID: p.OrganizationID, ProjectID: pid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]specView, 0, len(rows))
		for _, row := range rows {
			out = append(out, toSpecView(row))
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("GET /api/v1/specs/{id}/requirements", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		sid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		s, err := q.GetSpec(r.Context(), GetSpecParams{OrganizationID: p.OrganizationID, ID: sid})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		rows, err := q.ListRequirements(r.Context(), ListRequirementsParams{OrganizationID: p.OrganizationID, SpecID: sid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, reqViews(rows, s.SourceType))
	})))

	registerManage(mux, mw, pool)
}

var errVersionConflict = errors.New("spec version conflict")

// store creates the next spec version and its requirements atomically.
func store(ctx context.Context, pool *pgxpool.Pool, orgID, projectID uuid.UUID, sourceType, title, text string, items []Item,
	attach func(context.Context, pgx.Tx, map[string]uuid.UUID) error) (Spec, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Spec{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	q := New(tx)
	version, err := q.NextSpecVersion(ctx, NextSpecVersionParams{OrganizationID: orgID, ProjectID: projectID})
	if err != nil {
		return Spec{}, err
	}
	s, err := q.CreateSpec(ctx, CreateSpecParams{OrganizationID: orgID, ProjectID: projectID, Version: version, SourceType: sourceType, Title: title, ExtractedText: text})
	if err != nil {
		if strings.Contains(err.Error(), "specs_project_id_version_key") {
			return Spec{}, errVersionConflict
		}
		return Spec{}, err
	}
	ids := make(map[string]uuid.UUID, len(items))
	for _, it := range items {
		rq, err := q.CreateRequirement(ctx, CreateRequirementParams{OrganizationID: orgID, SpecID: s.ID, Key: it.Key, Text: it.Text, Criticality: it.Criticality, Status: it.Status})
		if err != nil {
			return Spec{}, err
		}
		ids[it.Key] = rq.ID
	}
	if attach != nil {
		if err := attach(ctx, tx, ids); err != nil {
			return Spec{}, err
		}
	}
	return s, tx.Commit(ctx)
}

func notFoundOr500(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "not found")
		return
	}
	httpx.Error(w, http.StatusInternalServerError, "internal error")
}
