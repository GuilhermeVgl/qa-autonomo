// Package config loads configuration from environment variables (12 factors).
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr    string
	DatabaseURL string
	MultiTenant bool
	AuthMode    string // "oidc" or "dev" (local users, dev only)
	OIDCIssuer  string
	OIDCClient  string
	OrgName     string
	OrgSlug     string

	EncryptionKey string // base64, 32 bytes (AES-256-GCM)

	RunnerBootstrapToken string // empty disables runner registration
	PublicURL            string // public base URL of the UI, used in links to runs (optional)

	StorageDriver         string // "" (evidence disabled) or "s3" (AWS S3, MinIO)
	StorageEndpoint       string // host:port the control plane uses
	StorageRunnerEndpoint string // host:port runners use in presigned URLs (defaults to StorageEndpoint)
	StorageAccessKey      string
	StorageSecretKey      string
	StorageBucket         string
	StorageRegion         string
	StorageUseSSL         bool

	LLMProvider   string // "", "azure_openai" or "openai_compatible"
	LLMEndpoint   string
	LLMAPIKey     string
	LLMAPIVersion string            // azure only
	LLMTimeout    time.Duration     // per provider call; local models can be slow
	LLMModel      string            // fallback for tasks without a specific model
	LLMModels     map[string]string // task -> model, from LLM_MODEL_<TASK>
}

// llmTasks are the gateway tasks that can be routed to their own model (CLAUDE.md, seção 11).
var llmTasks = []string{"explore", "plan", "extract_requirements", "judge_result", "summarize"}

// Load reads configuration through getenv, so tests need not touch the process env.
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		HTTPAddr:    getenv("HTTP_ADDR"),
		DatabaseURL: getenv("DATABASE_URL"),
		AuthMode:    getenv("AUTH_MODE"),
		OIDCIssuer:  getenv("OIDC_ISSUER"),
		OIDCClient:  getenv("OIDC_CLIENT_ID"),
		OrgName:     getenv("DEFAULT_ORG_NAME"),
		OrgSlug:     getenv("DEFAULT_ORG_SLUG"),
	}
	cfg.EncryptionKey = getenv("ENCRYPTION_KEY")
	cfg.RunnerBootstrapToken = getenv("RUNNER_BOOTSTRAP_TOKEN")
	cfg.PublicURL = strings.TrimRight(getenv("PUBLIC_URL"), "/")
	if key, err := base64.StdEncoding.DecodeString(cfg.EncryptionKey); err != nil || len(key) != 32 {
		return Config{}, errors.New("ENCRYPTION_KEY must be a base64-encoded 32-byte key")
	}
	if err := loadStorage(getenv, &cfg); err != nil {
		return Config{}, err
	}
	if err := loadLLM(getenv, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.AuthMode == "" {
		cfg.AuthMode = "oidc"
	}
	if cfg.OrgName == "" {
		cfg.OrgName = "KPMG"
	}
	if cfg.OrgSlug == "" {
		cfg.OrgSlug = "kpmg"
	}
	switch cfg.AuthMode {
	case "dev":
	case "oidc":
		if cfg.OIDCIssuer == "" || cfg.OIDCClient == "" {
			return Config{}, errors.New("AUTH_MODE=oidc requires OIDC_ISSUER and OIDC_CLIENT_ID")
		}
	default:
		return Config{}, fmt.Errorf("invalid AUTH_MODE %q (want oidc or dev)", cfg.AuthMode)
	}
	if cfg.HTTPAddr == "" {
		cfg.HTTPAddr = ":8080"
	}
	if v := getenv("MULTI_TENANT"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("invalid MULTI_TENANT %q: %w", v, err)
		}
		cfg.MultiTenant = b
	}
	return cfg, nil
}

func loadLLM(getenv func(string) string, cfg *Config) error {
	cfg.LLMProvider = getenv("LLM_PROVIDER")
	cfg.LLMEndpoint = strings.TrimRight(getenv("LLM_ENDPOINT"), "/")
	cfg.LLMAPIKey = getenv("LLM_API_KEY")
	cfg.LLMAPIVersion = getenv("LLM_API_VERSION")
	cfg.LLMModel = getenv("LLM_MODEL")
	cfg.LLMTimeout = 120 * time.Second
	if v := getenv("LLM_TIMEOUT_SECONDS"); v != "" {
		secs, err := strconv.Atoi(v)
		if err != nil || secs < 10 || secs > 3600 {
			return fmt.Errorf("invalid LLM_TIMEOUT_SECONDS %q (want 10 to 3600)", v)
		}
		cfg.LLMTimeout = time.Duration(secs) * time.Second
	}
	cfg.LLMModels = map[string]string{}
	if cfg.LLMAPIVersion == "" {
		cfg.LLMAPIVersion = "2024-10-21"
	}
	for _, task := range llmTasks {
		if m := getenv("LLM_MODEL_" + strings.ToUpper(task)); m != "" {
			cfg.LLMModels[task] = m
		}
	}
	switch cfg.LLMProvider {
	case "":
		return nil
	case "azure_openai":
		if cfg.LLMAPIKey == "" {
			return errors.New("LLM_PROVIDER=azure_openai requires LLM_API_KEY")
		}
	case "openai_compatible":
	default:
		return fmt.Errorf("invalid LLM_PROVIDER %q (want azure_openai or openai_compatible)", cfg.LLMProvider)
	}
	if cfg.LLMEndpoint == "" {
		return errors.New("LLM_PROVIDER requires LLM_ENDPOINT")
	}
	return nil
}

func loadStorage(getenv func(string) string, cfg *Config) error {
	cfg.StorageDriver = getenv("STORAGE_DRIVER")
	switch cfg.StorageDriver {
	case "":
		return nil
	case "s3":
	default:
		return fmt.Errorf("invalid STORAGE_DRIVER %q (want s3)", cfg.StorageDriver)
	}
	cfg.StorageEndpoint = getenv("STORAGE_ENDPOINT")
	cfg.StorageRunnerEndpoint = getenv("STORAGE_RUNNER_ENDPOINT")
	cfg.StorageAccessKey = getenv("STORAGE_ACCESS_KEY")
	cfg.StorageSecretKey = getenv("STORAGE_SECRET_KEY")
	cfg.StorageBucket = getenv("STORAGE_BUCKET")
	cfg.StorageRegion = getenv("STORAGE_REGION")
	if cfg.StorageBucket == "" {
		cfg.StorageBucket = "evidence"
	}
	if cfg.StorageEndpoint == "" || cfg.StorageAccessKey == "" || cfg.StorageSecretKey == "" {
		return errors.New("STORAGE_DRIVER=s3 requires STORAGE_ENDPOINT, STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY")
	}
	if v := getenv("STORAGE_USE_SSL"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return fmt.Errorf("invalid STORAGE_USE_SSL %q: %w", v, err)
		}
		cfg.StorageUseSSL = b
	}
	return nil
}
