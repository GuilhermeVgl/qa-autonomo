// Package junit renders a run as JUnit XML so CI systems (Azure DevOps, GitHub Actions, Jenkins) can show it.
package junit

import (
	"encoding/xml"
	"fmt"
)

type Requirement struct {
	Key         string
	Text        string
	Criticality string
	Outcome     string // pass | fail | error | skipped
	Detail      string
}

type Run struct {
	ID              string
	Type            string
	Status          string // succeeded | failed | cancelled ...
	DurationSeconds float64
	Requirements    []Requirement
}

type suitesXML struct {
	XMLName xml.Name   `xml:"testsuites"`
	Suites  []suiteXML `xml:"testsuite"`
}

type suiteXML struct {
	Name     string    `xml:"name,attr"`
	Tests    int       `xml:"tests,attr"`
	Failures int       `xml:"failures,attr"`
	Errors   int       `xml:"errors,attr"`
	Skipped  int       `xml:"skipped,attr"`
	Time     string    `xml:"time,attr"`
	Cases    []caseXML `xml:"testcase"`
}

type caseXML struct {
	Name      string     `xml:"name,attr"`
	Classname string     `xml:"classname,attr"`
	Failure   *messageXM `xml:"failure,omitempty"`
	Error     *messageXM `xml:"error,omitempty"`
	Skipped   *struct{}  `xml:"skipped,omitempty"`
}

type messageXM struct {
	Message string `xml:"message,attr"`
}

// Render builds the XML. Requirements become test cases; a run without requirements (an exploration) becomes a
// single case that fails unless the run succeeded. All text goes through encoding/xml, so app content is escaped.
func Render(r Run) ([]byte, error) {
	s := suiteXML{Name: fmt.Sprintf("qa-run %s (%s)", r.ID, r.Type), Time: fmt.Sprintf("%.3f", r.DurationSeconds)}
	for _, q := range r.Requirements {
		c := caseXML{Name: q.Key + " " + q.Text, Classname: q.Criticality}
		switch q.Outcome {
		case "fail":
			c.Failure = &messageXM{Message: q.Detail}
			s.Failures++
		case "error":
			c.Error = &messageXM{Message: q.Detail}
			s.Errors++
		case "skipped":
			c.Skipped = &struct{}{}
			s.Skipped++
		}
		s.Cases = append(s.Cases, c)
	}
	if len(r.Requirements) == 0 {
		c := caseXML{Name: "run " + r.Type, Classname: "run"}
		if r.Status != "succeeded" {
			c.Failure = &messageXM{Message: "run " + r.Status}
			s.Failures++
		}
		s.Cases = append(s.Cases, c)
	}
	s.Tests = len(s.Cases)
	out, err := xml.MarshalIndent(suitesXML{Suites: []suiteXML{s}}, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("render junit: %w", err)
	}
	return append([]byte(xml.Header), out...), nil
}
