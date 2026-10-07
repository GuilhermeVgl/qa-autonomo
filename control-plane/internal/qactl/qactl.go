// Package qactl is the CI command: create a run with a project token, optionally wait for it, write JUnit XML and
// translate the result into an exit code (CLAUDE.md, seção 8.6).
package qactl

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kpmg/agent-qa/control-plane/internal/junit"
)

// Exit codes.
const (
	ExitOK          = 0
	ExitTestsFailed = 1 // a critical requirement failed, or the run failed/was cancelled
	ExitUsage       = 2 // bad arguments, auth, or the server refused the request
	ExitTimeout     = 3 // --wait timed out
)

type runResp struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Link   string `json:"link"`
}

type reportResp struct {
	Run struct {
		Type            string  `json:"type"`
		Status          string  `json:"status"`
		DurationSeconds float64 `json:"duration_seconds"`
	} `json:"run"`
	Requirements []struct {
		Key         string `json:"key"`
		Text        string `json:"text"`
		Criticality string `json:"criticality"`
		Outcome     string `json:"outcome"`
	} `json:"requirements"`
}

// Main runs qactl. getenv, the writers and the client are injected so it can be tested end to end.
func Main(args []string, getenv func(string) string, stdout, stderr io.Writer, client *http.Client) int {
	if len(args) == 0 || args[0] != "run" {
		say(stderr, "usage: qactl run --env NAME --type exploration|regression [--wait] [--junit FILE] [--timeout 30m]")
		return ExitUsage
	}
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	server := fs.String("server", getenv("QACTL_SERVER"), "control plane URL (or QACTL_SERVER)")
	envName := fs.String("env", "", "environment name in the token's project")
	typ := fs.String("type", "", "exploration or regression")
	wait := fs.Bool("wait", false, "wait for the run to finish and fail the build on critical failures")
	junitFile := fs.String("junit", "", "write JUnit XML to this file")
	timeout := fs.String("timeout", "30m", "how long --wait may take")
	poll := fs.String("poll", "5s", "poll interval while waiting")
	if err := fs.Parse(args[1:]); err != nil {
		return ExitUsage
	}
	token := getenv("QACTL_TOKEN") // only from the environment: flags end up in process lists and CI logs
	if *server == "" || token == "" || *envName == "" || (*typ != "exploration" && *typ != "regression") {
		say(stderr, "qactl: --env, --type exploration|regression, QACTL_SERVER and QACTL_TOKEN are required")
		return ExitUsage
	}
	timeoutD, err1 := time.ParseDuration(*timeout)
	pollD, err2 := time.ParseDuration(*poll)
	if err1 != nil || err2 != nil || pollD <= 0 {
		say(stderr, "qactl: invalid --timeout or --poll")
		return ExitUsage
	}

	c := &api{base: strings.TrimRight(*server, "/"), token: token, client: client}
	var created runResp
	if err := c.do(http.MethodPost, "/ci/v1/runs", map[string]string{"environment": *envName, "type": *typ}, &created); err != nil {
		sayf(stderr, "qactl: creating the run failed: %v\n", err)
		return ExitUsage
	}
	link := created.Link
	if link == "" {
		link = c.base + "/runs/" + created.ID
	}
	sayf(stdout, "run %s created (%s)\n%s\n", created.ID, created.Status, link)
	if !*wait {
		return ExitOK
	}

	deadline := time.Now().Add(timeoutD)
	var status string
	for {
		var cur runResp
		if err := c.do(http.MethodGet, "/ci/v1/runs/"+created.ID, nil, &cur); err != nil {
			sayf(stderr, "qactl: polling failed: %v\n", err)
			return ExitUsage
		}
		status = cur.Status
		if status == "succeeded" || status == "failed" || status == "cancelled" {
			break
		}
		if time.Now().After(deadline) {
			sayf(stderr, "qactl: timed out waiting for run %s (still %s)\n", created.ID, status)
			return ExitTimeout
		}
		time.Sleep(pollD)
	}

	var rep reportResp
	if err := c.do(http.MethodGet, "/ci/v1/runs/"+created.ID+"/report", nil, &rep); err != nil {
		sayf(stderr, "qactl: fetching the report failed: %v\n", err)
		return ExitUsage
	}
	if *junitFile != "" {
		if err := writeJUnit(*junitFile, created.ID, status, rep); err != nil {
			sayf(stderr, "qactl: writing JUnit failed: %v\n", err)
			return ExitUsage
		}
	}

	failedCritical := 0
	for _, r := range rep.Requirements {
		if r.Criticality == "critical" && (r.Outcome == "fail" || r.Outcome == "error") {
			failedCritical++
			sayf(stdout, "critical requirement %s: %s\n", r.Key, r.Outcome)
		}
	}
	if status != "succeeded" || failedCritical > 0 {
		sayf(stdout, "run %s: %s, %d critical requirement(s) failing\n", created.ID, status, failedCritical)
		return ExitTestsFailed
	}
	sayf(stdout, "run %s: %s\n", created.ID, status)
	return ExitOK
}

func writeJUnit(path, id, status string, rep reportResp) error {
	run := junit.Run{ID: id, Type: rep.Run.Type, Status: status, DurationSeconds: rep.Run.DurationSeconds}
	for _, r := range rep.Requirements {
		run.Requirements = append(run.Requirements, junit.Requirement{Key: r.Key, Text: r.Text, Criticality: r.Criticality, Outcome: r.Outcome, Detail: "requirement " + r.Outcome})
	}
	data, err := junit.Render(run)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

type api struct {
	base, token string
	client      *http.Client
}

func (a *api) do(method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, a.base+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.client.Do(req) //nolint:gosec // the server URL is operator configuration
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("server answered %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out); err != nil {
		return errors.New("unexpected server response")
	}
	return nil
}

// say and sayf write user-facing output; a closed stdout/stderr is not something qactl can act on.
func say(w io.Writer, a ...any)            { _, _ = fmt.Fprintln(w, a...) }
func sayf(w io.Writer, f string, a ...any) { _, _ = fmt.Fprintf(w, f, a...) }
