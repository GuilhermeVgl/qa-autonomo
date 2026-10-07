package bug_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kpmg/agent-qa/control-plane/internal/bug"
)

// secStep records a finished security step of a check, the way the runner API does for each step that carries one.
func (f *fx) secStep(t *testing.T, runID uuid.UUID, node, result, actual string, sec bug.Security) {
	t.Helper()
	ctx := context.Background()
	var stepID uuid.UUID
	if err := f.h.Pool.QueryRow(ctx, `INSERT INTO run_steps (organization_id, run_id, client_key, node_id, executor, result, actual, security) VALUES ($1, $2, $3, $4, 'browser', $5, $6, $7::jsonb) RETURNING id`,
		f.h.OrgID, runID, uuid.NewString(), f.w.Nodes[node], result, actual, `{"check":"`+sec.Check+`","severity":"`+sec.Severity+`","scope":"`+sec.Scope+`"}`).Scan(&stepID); err != nil {
		t.Fatal(err)
	}
	if err := bug.Record(ctx, bug.New(f.h.Pool), bug.RecordInput{
		OrganizationID: f.h.OrgID, ProjectID: f.w.ProjectID, RunID: runID, StepID: stepID, NodeID: f.w.Nodes[node],
		NodeFingerprint: "fp" + node, NodeLabel: node, Result: result, Actual: actual, Security: &sec,
	}); err != nil {
		t.Fatal(err)
	}
}

type secBug struct {
	bugView
	Category string `json:"category"`
	Check    string `json:"check"`
}

func (f *fx) secList(query string) []secBug {
	f.h.T.Helper()
	var out []secBug
	rec := f.h.Do("GET", "/api/v1/projects/"+f.w.ProjectID.String()+"/bugs"+query, f.owner, nil)
	if rec.Code != http.StatusOK {
		f.h.T.Fatalf("list = %d %s", rec.Code, rec.Body)
	}
	f.h.JSON(rec, &out)
	return out
}

var xss = bug.Security{Check: "xss-reflected", Severity: "high", Scope: "/search?q"}

func TestRecord_ASecurityFindingIsABugOfItsOwnKindWithTheSeverityTheCheckGave(t *testing.T) {
	f := setup(t) // /orders has a critical requirement, and a functional bug already
	run2 := f.w.NewRun("exploration", time.Now().Add(-30*time.Minute), time.Minute)
	f.secStep(t, run2, "/orders", "fail", "XSS refletido: o parâmetro q volta sem escape", xss)

	found := f.secList("?category=security")
	if len(found) != 1 {
		t.Fatalf("security bugs = %+v, want 1", found)
	}
	b := found[0]
	if b.Category != "security" || b.Check != "xss-reflected" {
		t.Errorf("category=%q check=%q, want security / xss-reflected", b.Category, b.Check)
	}
	if b.Severity != "high" {
		t.Errorf("severity = %q, want the one the check gave (the requirement of /orders is critical and must not leak into it)", b.Severity)
	}
	if !strings.HasPrefix(b.Title, "Segurança · ") || strings.Contains(b.Title, "REQ-") {
		t.Errorf("title = %q, want 'Segurança · …' and no requirement", b.Title)
	}
	// the functional list does not mix with it
	if got := f.secList("?category=functional"); len(got) != 1 || got[0].Category != "functional" {
		t.Errorf("functional = %+v, want only the 500 of /orders", got)
	}
	if got := f.secList(""); len(got) != 2 {
		t.Errorf("all = %d, want both kinds", len(got))
	}
	if c := f.h.Do("GET", "/api/v1/projects/"+f.w.ProjectID.String()+"/bugs?category=bogus", f.owner, nil).Code; c != http.StatusBadRequest {
		t.Errorf("bogus category = %d, want 400", c)
	}
}

func TestRecord_TheSameFindingSeenOnAnotherScreenOrUserIsTheSameBug(t *testing.T) {
	f := setup(t)
	run2 := f.w.NewRun("exploration", time.Now().Add(-30*time.Minute), time.Minute)
	f.secStep(t, run2, "/orders", "fail", "Content-Security-Policy ausente", bug.Security{Check: "header-csp", Severity: "normal"})
	f.secStep(t, run2, "/customers", "fail", "Content-Security-Policy ausente", bug.Security{Check: "header-csp", Severity: "normal"}) // another user's first screen
	run3 := f.w.NewRun("regression", time.Now().Add(-10*time.Minute), time.Minute)
	f.secStep(t, run3, "/orders", "fail", "Content-Security-Policy ausente", bug.Security{Check: "header-csp", Severity: "normal"})

	got := f.secList("?category=security")
	if len(got) != 1 {
		t.Fatalf("security bugs = %d, want the finding once (it is the site's, not the screen's)", len(got))
	}
	if d := f.get(got[0].ID); len(d.Occurrences) != 3 {
		t.Errorf("occurrences = %d, want 3", len(d.Occurrences))
	}
	// a different scope of the same check is another finding
	f.secStep(t, run3, "/orders", "fail", "XSS refletido: q", bug.Security{Check: "xss-reflected", Severity: "high", Scope: "/a?q"})
	f.secStep(t, run3, "/orders", "fail", "XSS refletido: q", bug.Security{Check: "xss-reflected", Severity: "high", Scope: "/b?q"})
	if n := len(f.secList("?category=security")); n != 3 {
		t.Errorf("security bugs = %d, want 3 (csp, and xss on two different screens)", n)
	}
}

func TestRecord_ASecurityFindingIsFixedOnlyWhenItsOwnCheckPasses(t *testing.T) {
	f := setup(t)
	run2 := f.w.NewRun("exploration", time.Now().Add(-30*time.Minute), time.Minute)
	f.secStep(t, run2, "/orders", "fail", "XSS refletido: q", xss)
	f.secStep(t, run2, "/orders", "fail", "Content-Security-Policy ausente", bug.Security{Check: "header-csp", Severity: "normal"})

	run3 := f.w.NewRun("regression", time.Now().Add(-10*time.Minute), time.Minute)
	f.w.Step(run3, "/orders", "pass", "HTTP 200") // a functional pass on the same screen proves nothing about security
	status := func(check string) string {
		for _, b := range f.secList("?category=security") {
			if b.Check == check {
				return b.Status
			}
		}
		return "missing"
	}
	if s := status("xss-reflected"); s != "new" {
		t.Fatalf("after a functional pass the xss bug is %q, want still new", s)
	}
	f.secStep(t, run3, "/orders", "pass", "sem reflexão", bug.Security{Check: "xss-reflected", Severity: "high", Scope: "/other?q"}) // another screen being clean
	if s := status("xss-reflected"); s != "new" {
		t.Errorf("a clean check of another screen made it %q, want still new", s)
	}
	f.secStep(t, run3, "/orders", "pass", "sem reflexão", xss)
	if s := status("xss-reflected"); s != "fixed" {
		t.Errorf("after its own check passed the bug is %q, want fixed", s)
	}
	if s := status("header-csp"); s != "new" {
		t.Errorf("csp bug = %q, want untouched", s)
	}
	// and it comes back
	run4 := f.w.NewRun("regression", time.Now(), time.Minute)
	f.secStep(t, run4, "/orders", "fail", "XSS refletido: q", xss)
	if s := status("xss-reflected"); s != "reopened" {
		t.Errorf("after the failure came back it is %q, want reopened", s)
	}
}

func TestRecord_AFunctionalPassNeverFixesASecurityBug(t *testing.T) {
	f := setup(t)
	run2 := f.w.NewRun("exploration", time.Now().Add(-30*time.Minute), time.Minute)
	f.secStep(t, run2, "/orders", "fail", "XSS refletido: q", xss)
	run3 := f.w.NewRun("regression", time.Now(), time.Minute)
	f.w.Step(run3, "/orders", "pass", "HTTP 200") // fixes the 500 of /orders, which is a functional bug
	for _, b := range f.secList("") {
		if b.Category == "security" && b.Status != "new" {
			t.Errorf("security bug is %q after a functional pass, want new", b.Status)
		}
		if b.Category == "functional" && b.Status != "fixed" {
			t.Errorf("functional bug is %q, want fixed by its own pass", b.Status)
		}
	}
}
