// Package knowledge stores what a project has learned (answers to pendencies, false positives, notes).
package knowledge

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

type view struct {
	ID        uuid.UUID  `json:"id"`
	Content   string     `json:"content"`
	Origin    string     `json:"origin"`
	OriginID  *uuid.UUID `json:"origin_id"`
	CreatedAt time.Time  `json:"created_at"`
}

func Register(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	q := New(pool)
	mux.Handle("GET /api/v1/projects/{id}/knowledge", mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		pid, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return
		}
		rows, err := q.ListKnowledge(r.Context(), ListKnowledgeParams{OrganizationID: p.OrganizationID, ProjectID: pid})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		out := make([]view, 0, len(rows))
		for _, k := range rows {
			v := view{ID: k.ID, Content: k.Content, Origin: k.Origin, CreatedAt: k.CreatedAt.Time}
			if k.OriginID.Valid {
				v.OriginID = &k.OriginID.UUID
			}
			out = append(out, v)
		}
		httpx.WriteJSON(w, http.StatusOK, out)
	})))
}
