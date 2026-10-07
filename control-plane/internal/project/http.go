// Package project manages the applications under test.
package project

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

type view struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	q := New(pool)

	mux.Handle("POST /api/v1/projects", mw(auth.RequireWriter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		var in struct {
			Name string `json:"name"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		name := strings.TrimSpace(in.Name)
		if name == "" {
			httpx.Error(w, http.StatusBadRequest, "name is required")
			return
		}
		row, err := q.CreateProject(r.Context(), CreateProjectParams{OrganizationID: p.OrganizationID, Name: name})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, view{ID: row.ID, Name: row.Name})
	}))))

	mux.Handle("GET /api/v1/projects", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		rows, err := q.ListProjects(r.Context(), p.OrganizationID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]view, 0, len(rows))
		for _, row := range rows {
			out = append(out, view{ID: row.ID, Name: row.Name})
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))

	mux.Handle("GET /api/v1/projects/{id}", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		row, err := q.GetProject(r.Context(), GetProjectParams{OrganizationID: p.OrganizationID, ID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, view{ID: row.ID, Name: row.Name})
	})))
}
