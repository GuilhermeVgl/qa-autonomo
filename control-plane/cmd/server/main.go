package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kpmg/agent-qa/control-plane/internal/apitoken"
	"github.com/kpmg/agent-qa/control-plane/internal/auth"
	"github.com/kpmg/agent-qa/control-plane/internal/autospec"
	"github.com/kpmg/agent-qa/control-plane/internal/brief"
	"github.com/kpmg/agent-qa/control-plane/internal/bug"
	"github.com/kpmg/agent-qa/control-plane/internal/capability"
	"github.com/kpmg/agent-qa/control-plane/internal/capture"
	"github.com/kpmg/agent-qa/control-plane/internal/ci"
	"github.com/kpmg/agent-qa/control-plane/internal/config"
	"github.com/kpmg/agent-qa/control-plane/internal/database"
	"github.com/kpmg/agent-qa/control-plane/internal/environment"
	"github.com/kpmg/agent-qa/control-plane/internal/events"
	"github.com/kpmg/agent-qa/control-plane/internal/graph"
	"github.com/kpmg/agent-qa/control-plane/internal/health"
	"github.com/kpmg/agent-qa/control-plane/internal/knowledge"
	"github.com/kpmg/agent-qa/control-plane/internal/llm"
	"github.com/kpmg/agent-qa/control-plane/internal/org"
	"github.com/kpmg/agent-qa/control-plane/internal/pendency"
	"github.com/kpmg/agent-qa/control-plane/internal/project"
	"github.com/kpmg/agent-qa/control-plane/internal/report"
	"github.com/kpmg/agent-qa/control-plane/internal/run"
	"github.com/kpmg/agent-qa/control-plane/internal/runnerapi"
	"github.com/kpmg/agent-qa/control-plane/internal/schedule"
	"github.com/kpmg/agent-qa/control-plane/internal/secret"
	"github.com/kpmg/agent-qa/control-plane/internal/spec"
	"github.com/kpmg/agent-qa/control-plane/internal/step"
	"github.com/kpmg/agent-qa/control-plane/internal/storage"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := serve(log); err != nil {
		log.Error("server failed", "err", err)
		os.Exit(1)
	}
}

func serve(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := database.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := database.Migrate(ctx, pool); err != nil {
		return err
	}
	o, err := org.New(pool).EnsureOrganization(ctx, org.EnsureOrganizationParams{Name: cfg.OrgName, Slug: cfg.OrgSlug})
	if err != nil {
		return fmt.Errorf("ensure default organization: %w", err)
	}

	var verifier auth.Verifier = auth.DevVerifier{}
	if cfg.AuthMode == "oidc" {
		if verifier, err = auth.NewOIDCVerifier(ctx, cfg.OIDCIssuer, cfg.OIDCClient); err != nil {
			return err
		}
	} else {
		log.Warn("AUTH_MODE=dev: local users enabled, never use outside development")
	}

	box, err := secret.New(cfg.EncryptionKey)
	if err != nil {
		return err
	}

	var store storage.Store // nil without STORAGE_DRIVER: evidence endpoints answer 503
	if cfg.StorageDriver == "s3" {
		s3, err := storage.NewS3(storage.S3Config{
			Endpoint: cfg.StorageEndpoint, RunnerEndpoint: cfg.StorageRunnerEndpoint, AccessKey: cfg.StorageAccessKey,
			SecretKey: cfg.StorageSecretKey, Bucket: cfg.StorageBucket, Region: cfg.StorageRegion, UseSSL: cfg.StorageUseSSL,
		})
		if err != nil {
			return err
		}
		if err := s3.EnsureBucket(ctx); err != nil {
			return err
		}
		store = s3
	} else {
		log.Warn("STORAGE_DRIVER not set: evidence upload disabled")
	}

	var extractor spec.Extractor // nil without an LLM: spec ingestion and cross-reference answer 503
	var crossrefLLM pendency.Completer
	var runnerLLM runnerapi.Completer
	var briefLLM brief.Completer
	if gw := newGateway(cfg, pool); gw != nil {
		extractor = spec.NewLLMExtractor(gw)
		crossrefLLM = gw // assigned only when non-nil: a nil *Gateway inside the interface would not be nil
		runnerLLM = gw
		briefLLM = gw
	} else {
		log.Warn("LLM_PROVIDER not set: requirement extraction disabled")
	}

	authSvc := auth.NewService(pool, o.ID)
	mw := auth.Middleware(verifier, authSvc)
	mux := http.NewServeMux()
	health.Register(mux, pool.Ping)
	auth.Register(mux, verifier, authSvc)
	auth.RegisterConfig(mux, auth.ClientConfig{Mode: cfg.AuthMode, Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCClient})
	hub := events.NewHub(pool, graph.NotifyChannel)
	go func() { _ = hub.Run(ctx) }()
	captureHub := capture.NewHub(pool, box)
	go captureHub.Run(ctx)

	project.Register(mux, mw, pool)
	environment.Register(mux, mw, pool, box)
	spec.Register(mux, mw, pool, extractor)
	autospec.Register(mux, mw, pool)
	run.Register(mux, mw, pool)
	graph.Register(mux, mw, pool, hub)
	pendency.Register(mux, mw, pool, crossrefLLM)
	knowledge.Register(mux, mw, pool)
	step.Register(mux, mw, pool, store)
	bug.Register(mux, mw, pool)
	report.Register(mux, mw, pool)
	brief.Register(mux, mw, pool, briefLLM, brief.Capabilities{LLM: briefLLM != nil, Storage: store != nil})
	capability.Register(mux, mw, pool)
	apitoken.Register(mux, mw, pool)
	ci.Register(mux, pool, box, cfg.PublicURL)
	capture.Register(mux, mw, pool, captureHub)
	schedule.Register(mux, mw, pool)
	go schedule.Loop(ctx, pool, log, 30*time.Second)
	runnerapi.Register(mux, pool, runnerapi.Deps{Box: box, Capture: captureHub, BootstrapToken: cfg.RunnerBootstrapToken, OrganizationID: o.ID, LLM: runnerLLM, Storage: store})
	if cfg.RunnerBootstrapToken == "" {
		log.Warn("RUNNER_BOOTSTRAP_TOKEN not set: runner registration disabled")
	}

	srv := &http.Server{Addr: cfg.HTTPAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Info("listening", "addr", cfg.HTTPAddr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func newGateway(cfg config.Config, pool *pgxpool.Pool) *llm.Gateway {
	llm.SetTimeout(cfg.LLMTimeout)
	var p llm.Provider
	switch cfg.LLMProvider {
	case "azure_openai":
		p = llm.NewAzureOpenAI(cfg.LLMEndpoint, cfg.LLMAPIKey, cfg.LLMAPIVersion)
	case "openai_compatible":
		p = llm.NewOpenAICompatible(cfg.LLMEndpoint, cfg.LLMAPIKey)
	default:
		return nil
	}
	return llm.NewGateway(p, cfg.LLMProvider, cfg.LLMModels, cfg.LLMModel, llm.NewRecorder(pool))
}
