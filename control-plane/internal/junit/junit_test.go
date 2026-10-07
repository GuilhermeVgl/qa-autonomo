package junit

import (
	"encoding/xml"
	"strings"
	"testing"
)

type suites struct {
	XMLName xml.Name `xml:"testsuites"`
	Suites  []struct {
		Name     string `xml:"name,attr"`
		Tests    int    `xml:"tests,attr"`
		Failures int    `xml:"failures,attr"`
		Errors   int    `xml:"errors,attr"`
		Skipped  int    `xml:"skipped,attr"`
		Time     string `xml:"time,attr"`
		Cases    []struct {
			Name      string `xml:"name,attr"`
			Classname string `xml:"classname,attr"`
			Failure   *struct {
				Message string `xml:"message,attr"`
			} `xml:"failure"`
			Error *struct {
				Message string `xml:"message,attr"`
			} `xml:"error"`
			Skipped *struct{} `xml:"skipped"`
		} `xml:"testcase"`
	} `xml:"testsuite"`
}

func TestRender_MapsRequirementOutcomes(t *testing.T) {
	out, err := Render(Run{
		ID: "r1", Type: "regression", Status: "succeeded", DurationSeconds: 12.5,
		Requirements: []Requirement{
			{Key: "REQ-001", Text: "Lista pedidos", Criticality: "critical", Outcome: "fail", Detail: "HTTP 500"},
			{Key: "REQ-002", Text: "Clientes", Criticality: "high", Outcome: "pass"},
			{Key: "REQ-003", Text: "Faturas", Criticality: "normal", Outcome: "error", Detail: "timeout"},
			{Key: "REQ-004", Text: "Admin", Criticality: "normal", Outcome: "skipped"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(out), "<?xml") {
		t.Error("missing XML header")
	}
	var s suites
	if err := xml.Unmarshal(out, &s); err != nil {
		t.Fatalf("invalid XML: %v\n%s", err, out)
	}
	if len(s.Suites) != 1 {
		t.Fatalf("suites = %d", len(s.Suites))
	}
	su := s.Suites[0]
	if su.Name != "qa-run r1 (regression)" || su.Tests != 4 || su.Failures != 1 || su.Errors != 1 || su.Skipped != 1 || su.Time != "12.500" {
		t.Errorf("suite = %+v", su)
	}
	byName := map[string]int{}
	for i, c := range su.Cases {
		byName[c.Name] = i
	}
	c1 := su.Cases[byName["REQ-001 Lista pedidos"]]
	if c1.Failure == nil || c1.Failure.Message != "HTTP 500" || c1.Classname != "critical" {
		t.Errorf("REQ-001 = %+v", c1)
	}
	if su.Cases[byName["REQ-002 Clientes"]].Failure != nil {
		t.Error("passing requirement must not carry a failure")
	}
	if su.Cases[byName["REQ-003 Faturas"]].Error == nil || su.Cases[byName["REQ-004 Admin"]].Skipped == nil {
		t.Error("error/skipped not mapped")
	}
}

func TestRender_RunWithoutRequirementsStillYieldsOneTestcase(t *testing.T) {
	for status, wantFailure := range map[string]bool{"succeeded": false, "failed": true, "cancelled": true} {
		out, err := Render(Run{ID: "r2", Type: "exploration", Status: status})
		if err != nil {
			t.Fatal(err)
		}
		var s suites
		if err := xml.Unmarshal(out, &s); err != nil {
			t.Fatal(err)
		}
		su := s.Suites[0]
		if su.Tests != 1 || (su.Failures == 1) != wantFailure {
			t.Errorf("%s: tests=%d failures=%d", status, su.Tests, su.Failures)
		}
	}
}

func TestRender_EscapesUntrustedText(t *testing.T) {
	out, err := Render(Run{ID: "r3", Type: "regression", Status: "succeeded", Requirements: []Requirement{
		{Key: "REQ-001", Text: `</testcase><evil a="b">&`, Criticality: "normal", Outcome: "fail", Detail: "<script>x</script>"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "<evil") || strings.Contains(string(out), "<script>") {
		t.Errorf("unescaped markup in output:\n%s", out)
	}
	var s suites
	if err := xml.Unmarshal(out, &s); err != nil {
		t.Fatalf("output is not well-formed: %v", err)
	}
}
