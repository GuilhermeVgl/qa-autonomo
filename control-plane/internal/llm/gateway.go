// Package llm is the LLM gateway: provider adapters, per-task model routing and usage records.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Result struct {
	Content   string
	TokensIn  int32
	TokensOut int32
}

// Provider is an extension point (CLAUDE.md 4.3): azure_openai, openai_compatible.
type Provider interface {
	Chat(ctx context.Context, model string, msgs []Message, jsonMode bool) (Result, error)
}

type Usage struct {
	OrganizationID uuid.UUID
	RunID          uuid.NullUUID // set when the call belongs to a run (see WithRun)
	Task           string
	Provider       string
	Model          string
	TokensIn       int32
	TokensOut      int32
}

type runKey struct{}

// WithRun marks every gateway call made with the returned context as belonging to a run (cost per run).
func WithRun(ctx context.Context, runID uuid.UUID) context.Context {
	return context.WithValue(ctx, runKey{}, runID)
}

type Gateway struct {
	provider     Provider
	providerName string
	models       map[string]string // task -> model/deployment
	fallback     string
	record       func(context.Context, Usage) error
}

func NewGateway(p Provider, providerName string, models map[string]string, fallback string, record func(context.Context, Usage) error) *Gateway {
	return &Gateway{provider: p, providerName: providerName, models: models, fallback: fallback, record: record}
}

// Complete routes the task to its configured model, calls the provider and records usage.
func (g *Gateway) Complete(ctx context.Context, orgID uuid.UUID, task string, msgs []Message, jsonMode bool) (string, error) {
	model := g.models[task]
	if model == "" {
		model = g.fallback
	}
	if model == "" {
		return "", fmt.Errorf("no model configured for task %q", task)
	}
	res, err := g.provider.Chat(ctx, model, msgs, jsonMode)
	if err != nil {
		return "", fmt.Errorf("llm %s: %w", task, err)
	}
	var runID uuid.NullUUID
	if id, ok := ctx.Value(runKey{}).(uuid.UUID); ok {
		runID = uuid.NullUUID{UUID: id, Valid: true}
	}
	if err := g.record(ctx, Usage{OrganizationID: orgID, RunID: runID, Task: task, Provider: g.providerName, Model: model, TokensIn: res.TokensIn, TokensOut: res.TokensOut}); err != nil {
		return "", fmt.Errorf("record llm usage: %w", err)
	}
	if jsonMode {
		return extractJSON(res.Content), nil
	}
	return res.Content, nil
}

// extractJSON returns the JSON object inside a model reply. Small and local models often wrap it in a markdown fence
// or add a sentence around it even when asked for JSON only; callers still validate the result strictly, this only
// removes the envelope. A reply without an object is returned as it came.
func extractJSON(s string) string {
	start, end := strings.Index(s, "{"), strings.LastIndex(s, "}")
	if start < 0 || end < start {
		return s
	}
	return s[start : end+1]
}

var httpClient = &http.Client{Timeout: 120 * time.Second}

// SetTimeout changes how long one provider call may take. Hosted models answer in seconds; a model running on a
// laptop can need minutes for a long answer.
func SetTimeout(d time.Duration) { httpClient.Timeout = d }

type chatRequest struct {
	Model          string         `json:"model,omitempty"`
	Messages       []Message      `json:"messages"`
	ResponseFormat map[string]any `json:"response_format,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int32 `json:"prompt_tokens"`
		CompletionTokens int32 `json:"completion_tokens"`
	} `json:"usage"`
}

func doChat(ctx context.Context, endpoint string, headers map[string]string, req chatRequest, jsonMode bool) (Result, error) {
	if jsonMode {
		req.ResponseFormat = map[string]any{"type": "json_object"}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return Result{}, fmt.Errorf("marshal request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Result{}, fmt.Errorf("build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		if v != "" {
			httpReq.Header.Set(k, v)
		}
	}
	resp, err := httpClient.Do(httpReq) //nolint:gosec // endpoint is operator configuration, not user input
	if err != nil {
		return Result{}, fmt.Errorf("call provider: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return Result{}, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("provider status %d", resp.StatusCode) // body omitted: may echo prompts
	}
	var cr chatResponse
	if err := json.Unmarshal(raw, &cr); err != nil {
		return Result{}, fmt.Errorf("decode response: %w", err)
	}
	if len(cr.Choices) == 0 {
		return Result{}, errors.New("provider returned no choices")
	}
	return Result{Content: cr.Choices[0].Message.Content, TokensIn: cr.Usage.PromptTokens, TokensOut: cr.Usage.CompletionTokens}, nil
}

type openAICompatible struct{ endpoint, apiKey string }

// NewOpenAICompatible targets any OpenAI-compatible server (vLLM, Ollama...). endpoint includes /v1.
func NewOpenAICompatible(endpoint, apiKey string) Provider {
	return &openAICompatible{endpoint, apiKey}
}

func (p *openAICompatible) Chat(ctx context.Context, model string, msgs []Message, jsonMode bool) (Result, error) {
	h := map[string]string{}
	if p.apiKey != "" {
		h["Authorization"] = "Bearer " + p.apiKey
	}
	return doChat(ctx, p.endpoint+"/chat/completions", h, chatRequest{Model: model, Messages: msgs}, jsonMode)
}

type azureOpenAI struct{ endpoint, apiKey, apiVersion string }

// NewAzureOpenAI: the "model" of a task is the Azure deployment name.
func NewAzureOpenAI(endpoint, apiKey, apiVersion string) Provider {
	return &azureOpenAI{endpoint, apiKey, apiVersion}
}

func (p *azureOpenAI) Chat(ctx context.Context, deployment string, msgs []Message, jsonMode bool) (Result, error) {
	u := fmt.Sprintf("%s/openai/deployments/%s/chat/completions?api-version=%s",
		p.endpoint, url.PathEscape(deployment), url.QueryEscape(p.apiVersion))
	return doChat(ctx, u, map[string]string{"api-key": p.apiKey}, chatRequest{Messages: msgs}, jsonMode)
}
