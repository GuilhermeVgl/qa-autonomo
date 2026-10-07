package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

const okBody = `{"choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}`

func TestSetTimeout_LocalModelsMayBeSlow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(okBody))
	}))
	defer srv.Close()
	t.Cleanup(func() { SetTimeout(120 * time.Second) })
	chat := func() error {
		_, err := NewOpenAICompatible(srv.URL+"/v1", "").Chat(context.Background(), "m", []Message{{Role: "user", Content: "hi"}}, false)
		return err
	}

	SetTimeout(50 * time.Millisecond)
	if err := chat(); err == nil {
		t.Error("a response slower than the timeout must fail")
	}
	SetTimeout(5 * time.Second)
	if err := chat(); err != nil {
		t.Errorf("a longer timeout must let the slow model answer: %v", err)
	}
}

func TestOpenAICompatible_RequestAndResponse(t *testing.T) {
	var gotPath, gotAuth string
	var gotReq map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotReq)
		_, _ = w.Write([]byte(okBody))
	}))
	defer srv.Close()

	p := NewOpenAICompatible(srv.URL+"/v1", "k")
	res, err := p.Chat(context.Background(), "m1", []Message{{Role: "user", Content: "hi"}}, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Content != "hello" || res.TokensIn != 11 || res.TokensOut != 7 {
		t.Errorf("res = %+v", res)
	}
	if gotPath != "/v1/chat/completions" || gotAuth != "Bearer k" || gotReq["model"] != "m1" {
		t.Errorf("path=%q auth=%q req=%v", gotPath, gotAuth, gotReq)
	}
	if rf, _ := gotReq["response_format"].(map[string]any); rf["type"] != "json_object" {
		t.Errorf("json mode not requested: %v", gotReq)
	}
}

func TestAzure_UsesDeploymentAndAPIKey(t *testing.T) {
	var gotURL, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL, gotKey = r.URL.RequestURI(), r.Header.Get("api-key")
		_, _ = w.Write([]byte(okBody))
	}))
	defer srv.Close()

	p := NewAzureOpenAI(srv.URL, "key", "2024-10-21")
	if _, err := p.Chat(context.Background(), "my-deploy", nil, false); err != nil {
		t.Fatal(err)
	}
	want := "/openai/deployments/my-deploy/chat/completions?api-version=2024-10-21"
	if gotURL != want || gotKey != "key" {
		t.Errorf("url=%q key=%q", gotURL, gotKey)
	}
}

func TestProvider_ErrorStatusAndEmptyChoices(t *testing.T) {
	for name, handler := range map[string]http.HandlerFunc{
		"500":      func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "boom", 500) },
		"nochoice": func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"choices":[]}`)) },
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(handler)
			defer srv.Close()
			if _, err := NewOpenAICompatible(srv.URL, "").Chat(context.Background(), "m", nil, false); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

type fakeProvider struct{ model string }

func (f *fakeProvider) Chat(_ context.Context, model string, _ []Message, _ bool) (Result, error) {
	f.model = model
	return Result{Content: "ok", TokensIn: 3, TokensOut: 4}, nil
}

func TestGateway_RoutesByTaskAndRecordsUsage(t *testing.T) {
	fp := &fakeProvider{}
	var got Usage
	g := NewGateway(fp, "openai_compatible", map[string]string{"extract_requirements": "small", "explore": "strong"}, "fallback",
		func(_ context.Context, u Usage) error { got = u; return nil })

	org := uuid.New()
	out, err := g.Complete(context.Background(), org, "extract_requirements", nil, true)
	if err != nil || out != "ok" || fp.model != "small" {
		t.Fatalf("out=%q err=%v model=%q", out, err, fp.model)
	}
	if got.OrganizationID != org || got.Task != "extract_requirements" || got.Model != "small" || got.TokensIn != 3 || got.TokensOut != 4 || got.Provider != "openai_compatible" {
		t.Errorf("usage = %+v", got)
	}
	if _, err := g.Complete(context.Background(), org, "other", nil, false); err != nil || fp.model != "fallback" {
		t.Errorf("fallback model = %q err=%v", fp.model, err)
	}
}

type replyProvider struct{ reply string }

func (r replyProvider) Chat(context.Context, string, []Message, bool) (Result, error) {
	return Result{Content: r.reply}, nil
}

func TestExtractJSON_ToleratesWhatSmallModelsWrapAroundJSON(t *testing.T) {
	const obj = `{"links":[{"requirement":"REQ-001","node":"n1","confidence":0.9}],"note":"a } inside a string"}`
	cases := map[string]string{
		"plain":            obj,
		"fenced with lang": "```json\n" + obj + "\n```",
		"fenced no lang":   "```\n" + obj + "\n```",
		"prose around":     "Claro! Aqui está o resultado:\n" + obj + "\nEspero ter ajudado.",
		"spaces":           "\n\n  " + obj + "  \n",
	}
	for name, in := range cases {
		if got := extractJSON(in); got != obj {
			t.Errorf("%s: got %q", name, got)
		}
	}
	for _, in := range []string{"sem json aqui", "", "} antes {", "[1, 2, 3]"} {
		if got := extractJSON(in); got != in {
			t.Errorf("%q must pass through untouched, got %q", in, got)
		}
	}
}

func TestGateway_JSONModeCleansTheReplyAndTextModeKeepsIt(t *testing.T) {
	fenced := "```json\n{\"ok\":true}\n```"
	g := NewGateway(replyProvider{fenced}, "p", map[string]string{"plan": "m"}, "", func(context.Context, Usage) error { return nil })
	if got, _ := g.Complete(context.Background(), uuid.New(), "plan", nil, true); got != `{"ok":true}` {
		t.Errorf("json mode = %q", got)
	}
	if got, _ := g.Complete(context.Background(), uuid.New(), "plan", nil, false); got != fenced {
		t.Errorf("text mode must not touch the reply, got %q", got)
	}
}

func TestGateway_NoModelForTask(t *testing.T) {
	g := NewGateway(&fakeProvider{}, "p", nil, "", func(context.Context, Usage) error { return nil })
	if _, err := g.Complete(context.Background(), uuid.New(), "x", nil, false); err == nil {
		t.Fatal("expected error when no model is configured")
	}
}

func TestGateway_AttributesUsageToTheRunInContext(t *testing.T) {
	var got Usage
	g := NewGateway(&fakeProvider{}, "p", map[string]string{"explore": "m"}, "", func(_ context.Context, u Usage) error { got = u; return nil })
	runID := uuid.New()
	if _, err := g.Complete(WithRun(context.Background(), runID), uuid.New(), "explore", nil, false); err != nil {
		t.Fatal(err)
	}
	if !got.RunID.Valid || got.RunID.UUID != runID {
		t.Errorf("run id = %+v, want %s", got.RunID, runID)
	}
	if _, err := g.Complete(context.Background(), uuid.New(), "explore", nil, false); err != nil || got.RunID.Valid {
		t.Errorf("without a run in context RunID must be empty, got %+v (err %v)", got.RunID, err)
	}
}
