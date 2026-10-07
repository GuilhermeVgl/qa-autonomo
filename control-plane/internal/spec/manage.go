package spec

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/audit"
	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/httpx"
)

// reqView is a requirement as the API returns it: with its id, so it can be edited or removed.
type reqView struct {
	ID          uuid.UUID `json:"id"`
	Key         string    `json:"key"`
	Text        string    `json:"text"`
	Criticality string    `json:"criticality"`
	Status      string    `json:"status"`
	// Quality says why the text may be hard to test ("vago", "curto", "composto", "parecido com REQ-X"); empty when fine.
	Quality []string `json:"quality"`
}

func toReqView(r Requirement) reqView {
	q := []string{}
	if keyNumber.MatchString(r.Key) {
		q = append(q, Quality(r.Text)...)
	}
	return reqView{ID: r.ID, Key: r.Key, Text: r.Text, Criticality: r.Criticality, Status: r.Status, Quality: q}
}

// reqViews is the list of a spec, with the comparison between its requirements that a single one cannot make.
func reqViews(rows []Requirement) []reqView {
	flags := QualityOf(itemsOf(rows))
	out := make([]reqView, 0, len(rows))
	for _, r := range rows {
		v := toReqView(r)
		if f, ok := flags[r.Key]; ok {
			v.Quality = append([]string{}, f...)
		}
		out = append(out, v)
	}
	return out
}

const (
	maxTitleLen = 200
	maxTextLen  = 2000
)

func validCriticality(c string) bool { return c == "critical" || c == "high" || c == "normal" }

var reqKey = regexp.MustCompile(`^REQ-(\d+)$`)

// nextRequirementKey continues the REQ-NNN numbering of a spec; keys of other shapes (OpenAPI, generated) are ignored.
func nextRequirementKey(rows []Requirement) string {
	highest := 0
	for _, r := range rows {
		if m := reqKey.FindStringSubmatch(r.Key); m != nil {
			if n, err := strconv.Atoi(m[1]); err == nil && n > highest {
				highest = n
			}
		}
	}
	return fmt.Sprintf("REQ-%03d", highest+1)
}

func recordAudit(ctx context.Context, q *audit.Queries, p auth.Principal, action, target string, payload any) error {
	b, _ := json.Marshal(payload)
	return q.RecordAudit(ctx, audit.RecordAuditParams{OrganizationID: p.OrganizationID, Actor: p.UserID.String(), Action: action, Target: target, Payload: b})
}

// registerManage mounts what lets people keep their specs: rename, delete, and edit, add or remove requirements.
// Deleting never deletes defects: bugs found through a requirement stay, detached from it.
func registerManage(mux *http.ServeMux, mw func(http.Handler) http.Handler, pool *pgxpool.Pool) {
	q := New(pool)
	write := func(h http.HandlerFunc) http.Handler { return mw(auth.RequireWriter(h)) }
	id := func(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
		v, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.Error(w, http.StatusNotFound, "not found")
			return uuid.Nil, false
		}
		return v, true
	}

	mux.Handle("PATCH /api/v1/specs/{id}", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		sid, ok := id(w, r)
		if !ok {
			return
		}
		var in struct {
			Title string `json:"title"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		title := strings.TrimSpace(in.Title)
		if title == "" || len([]rune(title)) > maxTitleLen {
			httpx.Error(w, http.StatusBadRequest, "title is required and at most 200 characters")
			return
		}
		s, err := q.UpdateSpecTitle(r.Context(), UpdateSpecTitleParams{OrganizationID: p.OrganizationID, ID: sid, Title: title})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		if err := recordAudit(r.Context(), audit.New(pool), p, "spec.update", s.ID.String(), map[string]any{"title": title}); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, toSpecView(s))
	}))

	mux.Handle("DELETE /api/v1/specs/{id}", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		sid, ok := id(w, r)
		if !ok {
			return
		}
		ctx, org := r.Context(), p.OrganizationID
		s, err := q.GetSpec(ctx, GetSpecParams{OrganizationID: org, ID: sid})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		err = inTx(ctx, pool, func(tx pgx.Tx) error {
			tq := New(tx)
			if err := tq.DeleteLinksOfSpec(ctx, DeleteLinksOfSpecParams{OrganizationID: org, SpecID: sid}); err != nil {
				return err
			}
			if err := tq.DeletePendenciesOfSpec(ctx, DeletePendenciesOfSpecParams{OrganizationID: org, SpecID: sid}); err != nil {
				return err
			}
			if err := tq.DetachBugsFromSpec(ctx, DetachBugsFromSpecParams{OrganizationID: org, SpecID: sid}); err != nil {
				return err
			}
			if err := tq.DeleteRequirementsOfSpec(ctx, DeleteRequirementsOfSpecParams{OrganizationID: org, SpecID: sid}); err != nil {
				return err
			}
			if err := tq.DeleteSpec(ctx, DeleteSpecParams{OrganizationID: org, ID: sid}); err != nil {
				return err
			}
			return recordAudit(ctx, audit.New(tx), p, "spec.delete", sid.String(), map[string]any{"title": s.Title, "version": s.Version})
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	mux.Handle("POST /api/v1/specs/{id}/requirements", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		sid, ok := id(w, r)
		if !ok {
			return
		}
		var in struct {
			Text        string `json:"text"`
			Criticality string `json:"criticality"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		text := strings.TrimSpace(in.Text)
		if text == "" || len([]rune(text)) > maxTextLen || !validCriticality(in.Criticality) {
			httpx.Error(w, http.StatusBadRequest, "text (up to 2000 characters) and a criticality (critical, high or normal) are required")
			return
		}
		ctx, org := r.Context(), p.OrganizationID
		if _, err := q.GetSpec(ctx, GetSpecParams{OrganizationID: org, ID: sid}); err != nil {
			notFoundOr500(w, err)
			return
		}
		var created Requirement
		err := inTx(ctx, pool, func(tx pgx.Tx) error {
			tq := New(tx)
			rows, err := tq.ListRequirements(ctx, ListRequirementsParams{OrganizationID: org, SpecID: sid})
			if err != nil {
				return err
			}
			created, err = tq.CreateRequirement(ctx, CreateRequirementParams{OrganizationID: org, SpecID: sid, Key: nextRequirementKey(rows), Text: text, Criticality: in.Criticality, Status: "new"})
			if err != nil {
				return err
			}
			return recordAudit(ctx, audit.New(tx), p, "requirement.create", created.ID.String(), map[string]any{"spec_id": sid, "key": created.Key})
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, toReqView(created))
	}))

	mux.Handle("PATCH /api/v1/requirements/{id}", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		rid, ok := id(w, r)
		if !ok {
			return
		}
		var in struct {
			Text        *string `json:"text"`
			Criticality *string `json:"criticality"`
		}
		if !httpx.Decode(w, r, &in) {
			return
		}
		ctx, org := r.Context(), p.OrganizationID
		cur, err := q.GetRequirement(ctx, GetRequirementParams{OrganizationID: org, ID: rid})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		text, crit := cur.Text, cur.Criticality
		if in.Text == nil && in.Criticality == nil {
			httpx.Error(w, http.StatusBadRequest, "send text and/or criticality")
			return
		}
		if in.Text != nil {
			text = strings.TrimSpace(*in.Text)
			if text == "" || len([]rune(text)) > maxTextLen {
				httpx.Error(w, http.StatusBadRequest, "text is required and at most 2000 characters")
				return
			}
		}
		if in.Criticality != nil {
			if !validCriticality(*in.Criticality) {
				httpx.Error(w, http.StatusBadRequest, "criticality must be critical, high or normal")
				return
			}
			crit = *in.Criticality
		}
		updated, err := q.UpdateRequirement(ctx, UpdateRequirementParams{OrganizationID: org, ID: rid, Text: text, Criticality: crit, Status: "changed"})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		if err := recordAudit(ctx, audit.New(pool), p, "requirement.update", rid.String(), map[string]any{"key": cur.Key, "criticality": crit}); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		httpx.WriteJSON(w, http.StatusOK, toReqView(updated))
	}))

	mux.Handle("DELETE /api/v1/requirements/{id}", write(func(w http.ResponseWriter, r *http.Request) {
		p, _ := auth.PrincipalFrom(r.Context())
		rid, ok := id(w, r)
		if !ok {
			return
		}
		ctx, org := r.Context(), p.OrganizationID
		cur, err := q.GetRequirement(ctx, GetRequirementParams{OrganizationID: org, ID: rid})
		if err != nil {
			notFoundOr500(w, err)
			return
		}
		err = inTx(ctx, pool, func(tx pgx.Tx) error {
			tq := New(tx)
			if err := tq.DeleteLinksOfRequirement(ctx, DeleteLinksOfRequirementParams{OrganizationID: org, RequirementID: rid}); err != nil {
				return err
			}
			if err := tq.DeletePendenciesOfRequirement(ctx, DeletePendenciesOfRequirementParams{OrganizationID: org, RequirementID: rid}); err != nil {
				return err
			}
			if err := tq.DetachBugsFromRequirement(ctx, DetachBugsFromRequirementParams{OrganizationID: org, RequirementID: uuid.NullUUID{UUID: rid, Valid: true}}); err != nil {
				return err
			}
			if err := tq.DeleteRequirement(ctx, DeleteRequirementParams{OrganizationID: org, ID: rid}); err != nil {
				return err
			}
			return recordAudit(ctx, audit.New(tx), p, "requirement.delete", rid.String(), map[string]any{"spec_id": cur.SpecID, "key": cur.Key})
		})
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "internal error")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
}

// inTx runs fn in a transaction that is rolled back unless fn succeeds.
func inTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
