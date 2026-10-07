package brief

import (
	"strings"
	"testing"
	"time"
)

func withSecurity(in input) input {
	in.Bugs = []bugRow{
		{Title: "Cabeçalho ausente", Severity: "normal", Status: "new", Category: "security", Users: []string{"admin"}},
		{Title: "Segurança · Possível SQL injection: /item (id)", Severity: "critical", Status: "new", Category: "security", Users: []string{"admin", "operador"}},
		{Title: "Segurança · XSS refletido", Severity: "high", Status: "confirmed", Category: "security"},
		{Title: "Segurança · cookie sem HttpOnly", Severity: "high", Status: "fixed", Category: "security"},
		{Title: "REQ-001 · /orders: HTTP 500", Severity: "critical", Status: "new", Category: "functional"},
	}
	return in
}

func TestAnalyze_SecurityBugsAreCountedApartFromTheTestBugs(t *testing.T) {
	f := analyze(withSecurity(shop().in))
	if f.Bugs.Open != 1 || f.Bugs.Critical != 1 || len(f.Bugs.List) != 1 {
		t.Errorf("bugs = %+v, want only the functional one", f.Bugs)
	}
	s := f.Security
	if s.Open != 3 || s.Critical != 1 || s.High != 1 || s.Normal != 1 || s.Fixed != 1 {
		t.Errorf("security = %+v, want 3 open (1 critical, 1 high, 1 normal) and 1 fixed", s)
	}
	if len(s.List) != 3 || s.List[0].Severity != "critical" || s.List[2].Severity != "normal" {
		t.Errorf("list = %+v, want the most serious first", s.List)
	}
}

func TestAnalyze_SecurityChecksRemembersWhatTheLastRunThatMadeThemCameTo(t *testing.T) {
	in := shop().in
	f := analyze(in)
	if f.Security.Checked {
		t.Error("nothing ran the checks yet")
	}
	in.Exploration = &runInfo{Type: "exploration", Status: "succeeded", FinishedAt: in.Now.Add(-2 * time.Hour), Summary: []byte(`{"pages":9,"security":{"checks":40,"failed":6,"probes":3}}`)}
	f = analyze(in)
	if !f.Security.Checked || f.Security.Checks != 40 || f.Security.Failed != 6 || f.Security.Probes != 3 {
		t.Errorf("security = %+v, want what the exploration said", f.Security)
	}
	// a later regression that made them is the more recent word
	in.Regression = &regressionInfo{FinishedAt: in.Now.Add(-time.Hour)}
	in.Regression.Report.Summary = map[string]any{"security": map[string]any{"checks": 55, "failed": 2, "probes": 7}}
	f = analyze(in)
	if f.Security.Checks != 55 || f.Security.Failed != 2 || f.Security.Probes != 7 {
		t.Errorf("security = %+v, want the regression's: it is the latest", f.Security)
	}
	// and one that did not (older runs, or the checks turned off) does not erase it
	in.Regression.Report.Summary = map[string]any{"steps": 12}
	f = analyze(in)
	if f.Security.Checks != 40 {
		t.Errorf("security = %+v, want the exploration's again", f.Security)
	}
}

func TestIssues_SecurityFindingsAreRankedBySeriousnessAndNeverCheckedIsSaid(t *testing.T) {
	codes := func(in input) map[string]string {
		out := map[string]string{}
		for _, i := range analyze(in).Issues {
			out[i.Code] = i.Severity
		}
		return out
	}
	got := codes(withSecurity(shop().in))
	if got["security_critical"] != "alta" || got["security_high"] != "média" {
		t.Errorf("issues = %v, want critical flaws as alta and high ones as média", got)
	}
	if _, ok := got["security_unchecked"]; ok {
		t.Error("there are security findings: it was checked")
	}
	if got := codes(shop().in); got["security_unchecked"] != "baixa" {
		t.Errorf("issues = %v, want a note that security was never checked", got)
	}
	checked := shop().in
	checked.Exploration = &runInfo{Type: "exploration", Status: "succeeded", FinishedAt: checked.Now, Summary: []byte(`{"security":{"checks":10,"failed":0,"probes":1}}`)}
	if got := codes(checked); got["security_unchecked"] != "" || got["security_critical"] != "" {
		t.Errorf("issues = %v, want nothing about security: it ran and found nothing", got)
	}
	// nothing to say before there is a map
	if got := codes(input{Project: "P", Env: envInfo{Name: "e"}}); len(got) != 1 || got["no_map"] == "" {
		t.Errorf("issues = %v", got)
	}
}

func TestTemplate_HasASecuritySectionBeforeTheNextSteps(t *testing.T) {
	in := withSecurity(shop().in)
	in.Exploration = &runInfo{Type: "exploration", Status: "succeeded", FinishedAt: in.Now, Summary: []byte(`{"security":{"checks":40,"failed":6,"probes":3}}`)}
	n := Template(analyze(in))
	var ids []string
	var sec string
	for _, s := range n.Sections {
		ids = append(ids, s.ID)
		if s.ID == "security" {
			sec = s.Body
			if s.Title != "Segurança" {
				t.Errorf("title = %q", s.Title)
			}
		}
	}
	if strings.Join(ids, ",") != "scope,coverage,flows,users,results,risks,security,next" {
		t.Errorf("sections = %v", ids)
	}
	for _, want := range []string{"40", "6", "SQL injection", "crítico", "admin, operador", "pentest"} {
		if !strings.Contains(sec, want) {
			t.Errorf("security section lacks %q:\n%s", want, sec)
		}
	}
	// the test bugs stay in their own section
	for _, s := range n.Sections {
		if s.ID == "risks" && strings.Contains(s.Body, "SQL injection") {
			t.Errorf("risks mixes in security findings:\n%s", s.Body)
		}
	}
	if !strings.Contains(n.ExecutiveSummary, "segurança") {
		t.Errorf("summary = %q, want it to mention security", n.ExecutiveSummary)
	}
	recs := strings.Join(n.Recommendations, "\n")
	if !strings.Contains(recs, "segurança") {
		t.Errorf("recommendations = %q, want one about security", recs)
	}
}

func TestTemplate_SaysSecurityWasNeverChecked(t *testing.T) {
	n := Template(analyze(shop().in))
	for _, s := range n.Sections {
		if s.ID == "security" && !strings.Contains(s.Body, "ainda não") {
			t.Errorf("security section = %q, want it to say the checks did not run yet", s.Body)
		}
	}
}
