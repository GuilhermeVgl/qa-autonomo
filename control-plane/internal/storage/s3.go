// Package storage holds evidence and original documents in object storage (CLAUDE.md, seção 4.2: never on local disk).
// S3 (including MinIO) is implemented; Azure Blob is the other planned driver behind the same methods.
package storage

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Store is the extension point (CLAUDE.md 4.3) for storage drivers.
type Store interface {
	EnsureBucket(ctx context.Context) error
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Size(ctx context.Context, key string) (int64, error)
	Delete(ctx context.Context, key string) error
	// PresignPut returns a URL a runner can PUT to directly, reachable from the runner's network.
	PresignPut(ctx context.Context, key string, ttl time.Duration) (string, error)
}

type S3Config struct {
	Endpoint       string // host:port the control plane uses
	RunnerEndpoint string // host:port runners use in presigned URLs (defaults to Endpoint)
	AccessKey      string
	SecretKey      string
	Bucket         string
	Region         string
	UseSSL         bool
}

type S3 struct {
	ops     *minio.Client // control plane operations
	signing *minio.Client // same credentials, host as seen by runners
	bucket  string
	region  string
}

func NewS3(cfg S3Config) (*S3, error) {
	if cfg.Region == "" {
		cfg.Region = "us-east-1" // fixed region so presigning never needs a network round trip
	}
	mk := func(endpoint string) (*minio.Client, error) {
		return minio.New(endpoint, &minio.Options{
			Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
			Secure: cfg.UseSSL,
			Region: cfg.Region,
		})
	}
	ops, err := mk(cfg.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("storage client: %w", err)
	}
	runnerEndpoint := cfg.RunnerEndpoint
	if runnerEndpoint == "" {
		runnerEndpoint = cfg.Endpoint
	}
	signing, err := mk(runnerEndpoint)
	if err != nil {
		return nil, fmt.Errorf("storage signing client: %w", err)
	}
	return &S3{ops: ops, signing: signing, bucket: cfg.Bucket, region: cfg.Region}, nil
}

func (s *S3) EnsureBucket(ctx context.Context) error {
	exists, err := s.ops.BucketExists(ctx, s.bucket)
	if err != nil {
		return fmt.Errorf("check bucket: %w", err)
	}
	if exists {
		return nil
	}
	if err := s.ops.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{Region: s.region}); err != nil {
		return fmt.Errorf("make bucket: %w", err)
	}
	return nil
}

func (s *S3) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	if _, err := s.ops.PutObject(ctx, s.bucket, key, r, size, minio.PutObjectOptions{ContentType: contentType}); err != nil {
		return fmt.Errorf("put object: %w", err)
	}
	return nil
}

func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.ops.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("get object: %w", err)
	}
	if _, err := obj.Stat(); err != nil { // surfaces "not found" now instead of on first read
		_ = obj.Close()
		return nil, fmt.Errorf("get object: %w", err)
	}
	return obj, nil
}

func (s *S3) Size(ctx context.Context, key string) (int64, error) {
	info, err := s.ops.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return 0, fmt.Errorf("stat object: %w", err)
	}
	return info.Size, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	if err := s.ops.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("remove object: %w", err)
	}
	return nil
}

func (s *S3) PresignPut(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.signing.PresignedPutObject(ctx, s.bucket, key, ttl)
	if err != nil {
		return "", fmt.Errorf("presign put: %w", err)
	}
	return (&url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path, RawQuery: u.RawQuery}).String(), nil
}
