package config

import (
	"bytes"
	"encoding/base64"
	"testing"
	"time"
)

var validKey = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))

// load builds a config from env on top of a valid dev baseline.
func load(env map[string]string) (Config, error) {
	base := map[string]string{"AUTH_MODE": "dev", "ENCRYPTION_KEY": validKey}
	for k, v := range env {
		base[k] = v
	}
	return Load(func(k string) string { return base[k] })
}

func TestLoad_Defaults(t *testing.T) {
	cfg, err := load(nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.HTTPAddr != ":8080" || cfg.MultiTenant || cfg.OrgSlug != "kpmg" || cfg.LLMProvider != "" {
		t.Errorf("unexpected defaults: %+v", cfg)
	}
}

func TestLoad_FromEnv(t *testing.T) {
	cfg, err := load(map[string]string{"DATABASE_URL": "postgres://x", "HTTP_ADDR": ":9090", "MULTI_TENANT": "true"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.DatabaseURL != "postgres://x" || cfg.HTTPAddr != ":9090" || !cfg.MultiTenant {
		t.Errorf("unexpected config: %+v", cfg)
	}
}

func TestLoad_InvalidValues(t *testing.T) {
	cases := map[string]map[string]string{
		"multi tenant":      {"MULTI_TENANT": "maybe"},
		"missing key":       {"ENCRYPTION_KEY": ""},
		"short key":         {"ENCRYPTION_KEY": base64.StdEncoding.EncodeToString([]byte("short"))},
		"unknown auth mode": {"AUTH_MODE": "other"},
		"oidc w/o issuer":   {"AUTH_MODE": "oidc"},
		"unknown provider":  {"LLM_PROVIDER": "bard"},
		"llm w/o endpoint":  {"LLM_PROVIDER": "openai_compatible"},
		"azure w/o key":     {"LLM_PROVIDER": "azure_openai", "LLM_ENDPOINT": "https://x"},
	}
	for name, env := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := load(env); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoad_OIDC(t *testing.T) {
	cfg, err := load(map[string]string{"AUTH_MODE": "oidc", "OIDC_ISSUER": "https://i", "OIDC_CLIENT_ID": "c"})
	if err != nil || cfg.OIDCIssuer != "https://i" {
		t.Fatalf("%+v, %v", cfg, err)
	}
	if _, err := Load(func(k string) string { return map[string]string{"ENCRYPTION_KEY": validKey}[k] }); err == nil {
		t.Error("default AUTH_MODE is oidc and must require its settings")
	}
}

func TestLoad_LLMRouting(t *testing.T) {
	cfg, err := load(map[string]string{
		"LLM_PROVIDER": "azure_openai", "LLM_ENDPOINT": "https://az", "LLM_API_KEY": "k",
		"LLM_MODEL": "gpt-small", "LLM_MODEL_EXPLORE": "gpt-strong", "LLM_MODEL_EXTRACT_REQUIREMENTS": "gpt-mini",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMModel != "gpt-small" || cfg.LLMModels["explore"] != "gpt-strong" || cfg.LLMModels["extract_requirements"] != "gpt-mini" {
		t.Errorf("models = %q %v", cfg.LLMModel, cfg.LLMModels)
	}
	if cfg.LLMAPIVersion == "" {
		t.Error("api version should have a default")
	}
	if _, ok := cfg.LLMModels["plan"]; ok {
		t.Error("unset tasks must not appear")
	}
}

func TestLoad_LLMTimeout(t *testing.T) {
	cfg, err := load(nil)
	if err != nil || cfg.LLMTimeout != 120*time.Second {
		t.Fatalf("default = %v, %v", cfg.LLMTimeout, err)
	}
	cfg, err = load(map[string]string{"LLM_TIMEOUT_SECONDS": "900"})
	if err != nil || cfg.LLMTimeout != 900*time.Second {
		t.Fatalf("900s = %v, %v", cfg.LLMTimeout, err)
	}
	for _, bad := range []string{"abc", "5", "0", "-1", "100000"} {
		if _, err := load(map[string]string{"LLM_TIMEOUT_SECONDS": bad}); err == nil {
			t.Errorf("LLM_TIMEOUT_SECONDS=%q must be rejected", bad)
		}
	}
}

func TestLoad_RunnerBootstrapToken(t *testing.T) {
	cfg, err := load(map[string]string{"RUNNER_BOOTSTRAP_TOKEN": "tok"})
	if err != nil || cfg.RunnerBootstrapToken != "tok" {
		t.Fatalf("%+v, %v", cfg, err)
	}
	if cfg, _ := load(nil); cfg.RunnerBootstrapToken != "" {
		t.Error("registration must be disabled by default")
	}
}

func TestLoad_Storage(t *testing.T) {
	cfg, err := load(nil)
	if err != nil || cfg.StorageDriver != "" {
		t.Fatalf("storage must be optional: %+v, %v", cfg, err)
	}
	cfg, err = load(map[string]string{
		"STORAGE_DRIVER": "s3", "STORAGE_ENDPOINT": "minio:9000", "STORAGE_RUNNER_ENDPOINT": "files.example:9000",
		"STORAGE_ACCESS_KEY": "ak", "STORAGE_SECRET_KEY": "sk", "STORAGE_BUCKET": "ev", "STORAGE_USE_SSL": "true",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StorageDriver != "s3" || cfg.StorageEndpoint != "minio:9000" || cfg.StorageRunnerEndpoint != "files.example:9000" ||
		cfg.StorageBucket != "ev" || !cfg.StorageUseSSL || cfg.StorageAccessKey != "ak" || cfg.StorageSecretKey != "sk" {
		t.Errorf("cfg = %+v", cfg)
	}
	for name, env := range map[string]map[string]string{
		"unknown driver":     {"STORAGE_DRIVER": "ftp"},
		"s3 w/o endpoint":    {"STORAGE_DRIVER": "s3", "STORAGE_ACCESS_KEY": "a", "STORAGE_SECRET_KEY": "b"},
		"s3 w/o credentials": {"STORAGE_DRIVER": "s3", "STORAGE_ENDPOINT": "minio:9000"},
		"bad ssl flag":       {"STORAGE_DRIVER": "s3", "STORAGE_ENDPOINT": "m:9000", "STORAGE_ACCESS_KEY": "a", "STORAGE_SECRET_KEY": "b", "STORAGE_USE_SSL": "maybe"},
	} {
		if _, err := load(env); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if cfg, _ := load(map[string]string{"STORAGE_DRIVER": "s3", "STORAGE_ENDPOINT": "m:9000", "STORAGE_ACCESS_KEY": "a", "STORAGE_SECRET_KEY": "b"}); cfg.StorageBucket != "evidence" {
		t.Errorf("default bucket = %q, want evidence", cfg.StorageBucket)
	}
}

func TestLoad_PublicURL(t *testing.T) {
	cfg, err := load(map[string]string{"PUBLIC_URL": "https://qa.example/"})
	if err != nil || cfg.PublicURL != "https://qa.example" {
		t.Fatalf("%+v, %v", cfg, err)
	}
}
