package qactl

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

type fakeCI struct {
	statuses []string // successive statuses returned by GET /ci/v1/runs/{id}
	report   map[string]any
	polls    atomic.Int32
	created  map[string]any
	authSeen string
	createSC int
}

func (f *fakeCI) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ci/v1/runs", func(w http.ResponseWriter, r *http.Request) {
		f.authSeen = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&f.created)
		if f.createSC != 0 {
			w.WriteHeader(f.createSC)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "run-1", "status": "queued", "type": "regression", "link": "https://qa.example/runs/run-1"})
	})
	mux.HandleFunc("GET /ci/v1/runs/run-1", func(w http.ResponseWriter, _ *http.Request) {
		i := int(f.polls.Add(1)) - 1
		if i >= len(f.statuses) {
			i = len(f.statuses) - 1
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "run-1", "status": f.statuses[i]})
	})
	mux.HandleFunc("GET /ci/v1/runs/run-1/report", func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(f.report) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func report(status string, reqs ...map[string]any) map[string]any {
	return map[string]any{
		"run":          map[string]any{"id": "run-1", "type": "regression", "status": status, "duration_seconds": 3.0},
		"requirements": reqs,
	}
}

func req(key, crit, outcome string) map[string]any {
	return map[string]any{"key": key, "text": key + " text", "criticality": crit, "outcome": outcome}
}

func run(t *testing.T, srv *httptest.Server, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	env := map[string]string{"QACTL_SERVER": srv.URL, "QACTL_TOKEN": "qat_secret"}
	base := []string{"run", "--env", "hml", "--type", "regression", "--poll", "1ms"}
	code := Main(append(base, args...), func(k string) string { return env[k] }, &out, &errb, srv.Client())
	return code, out.String(), errb.String()
}

func TestRun_NoWaitCreatesTheRunAndPrintsTheLink(t *testing.T) {
	f := &fakeCI{statuses: []string{"queued"}}
	code, out, _ := run(t, f.server(t))
	if code != ExitOK {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(out, "run-1") || !strings.Contains(out, "https://qa.example/runs/run-1") {
		t.Errorf("output = %q", out)
	}
	if f.created["environment"] != "hml" || f.created["type"] != "regression" || f.authSeen != "Bearer qat_secret" {
		t.Errorf("request = %v auth=%q", f.created, f.authSeen)
	}
	if f.polls.Load() != 0 {
		t.Error("without --wait it must not poll")
	}
}

func TestRun_WaitPollsUntilFinishedAndPassesWhenNoCriticalRequirementFails(t *testing.T) {
	f := &fakeCI{statuses: []string{"queued", "running", "succeeded"}, report: report("succeeded", req("REQ-001", "critical", "pass"), req("REQ-002", "normal", "fail"))}
	code, out, _ := run(t, f.server(t), "--wait")
	if code != ExitOK {
		t.Fatalf("exit = %d (a non-critical failure must not break the build)\n%s", code, out)
	}
	if f.polls.Load() < 3 {
		t.Errorf("polls = %d, want at least 3", f.polls.Load())
	}
}

func TestRun_FailsTheBuildWhenACriticalRequirementFailsOrErrors(t *testing.T) {
	for _, outcome := range []string{"fail", "error"} {
		f := &fakeCI{statuses: []string{"succeeded"}, report: report("succeeded", req("REQ-001", "critical", outcome))}
		if code, _, _ := run(t, f.server(t), "--wait"); code != ExitTestsFailed {
			t.Errorf("critical %s: exit = %d, want %d", outcome, code, ExitTestsFailed)
		}
	}
}

func TestRun_FailsWhenTheRunItselfFailed(t *testing.T) {
	for _, status := range []string{"failed", "cancelled"} {
		f := &fakeCI{statuses: []string{status}, report: report(status)}
		if code, _, _ := run(t, f.server(t), "--wait"); code != ExitTestsFailed {
			t.Errorf("%s: exit = %d, want %d", status, code, ExitTestsFailed)
		}
	}
}

func TestRun_WritesJUnitXML(t *testing.T) {
	f := &fakeCI{statuses: []string{"succeeded"}, report: report("succeeded", req("REQ-001", "critical", "fail"))}
	file := filepath.Join(t.TempDir(), "out", "junit.xml")
	code, _, _ := run(t, f.server(t), "--wait", "--junit", file)
	if code != ExitTestsFailed {
		t.Fatalf("exit = %d", code)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("junit not written: %v", err)
	}
	var doc struct {
		Suites []struct {
			Failures int `xml:"failures,attr"`
		} `xml:"testsuite"`
	}
	if err := xml.Unmarshal(data, &doc); err != nil || len(doc.Suites) != 1 || doc.Suites[0].Failures != 1 {
		t.Errorf("junit = %s (%v)", data, err)
	}
}

func TestRun_TimeoutAndTransportErrorsHaveTheirOwnExitCodes(t *testing.T) {
	f := &fakeCI{statuses: []string{"running"}}
	if code, _, _ := run(t, f.server(t), "--wait", "--timeout", "30ms"); code != ExitTimeout {
		t.Errorf("timeout exit = %d, want %d", code, ExitTimeout)
	}
	unauth := &fakeCI{statuses: []string{"queued"}, createSC: http.StatusUnauthorized}
	code, _, errOut := run(t, unauth.server(t))
	if code != ExitUsage || !strings.Contains(errOut, "401") {
		t.Errorf("401: exit = %d stderr = %q", code, errOut)
	}
	conflict := &fakeCI{createSC: http.StatusConflict}
	if code, _, _ := run(t, conflict.server(t)); code != ExitUsage {
		t.Errorf("409 on create: exit = %d, want %d", code, ExitUsage)
	}
}

func TestMain_UsageErrors(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	var out, errb bytes.Buffer
	ok := func(k string) string { return map[string]string{"QACTL_SERVER": srv.URL, "QACTL_TOKEN": "t"}[k] }
	cases := map[string][]string{
		"no command":     {},
		"unknown":        {"explode"},
		"missing env":    {"run", "--type", "regression"},
		"bad type":       {"run", "--env", "hml", "--type", "chaos"},
		"bad flag":       {"run", "--nope"},
		"unknown format": {"run", "--env", "hml", "--type", "regression", "--timeout", "abc"},
	}
	for name, args := range cases {
		if code := Main(args, ok, &out, &errb, srv.Client()); code != ExitUsage {
			t.Errorf("%s: exit = %d, want %d", name, code, ExitUsage)
		}
	}
	noToken := func(k string) string { return map[string]string{"QACTL_SERVER": srv.URL}[k] }
	if code := Main([]string{"run", "--env", "hml", "--type", "regression"}, noToken, &out, &errb, srv.Client()); code != ExitUsage {
		t.Errorf("missing token: exit = %d", code)
	}
}

func TestRun_NeverPrintsTheToken(t *testing.T) {
	f := &fakeCI{statuses: []string{"succeeded"}, report: report("succeeded")}
	_, out, errOut := run(t, f.server(t), "--wait")
	if strings.Contains(out+errOut, "qat_secret") {
		t.Error("token leaked to the output")
	}
}
