package storage_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/kpmg/agent-qa/control-plane/internal/storage"
	"github.com/kpmg/agent-qa/control-plane/internal/testutil"
)

func newStore(t *testing.T) *storage.S3 {
	t.Helper()
	cfg := testutil.NewMinio(t)
	s, err := storage.NewS3(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureBucket(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestS3_PutGetStat(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	if err := s.Put(ctx, "a/b.txt", bytes.NewReader([]byte("hello")), 5, "text/plain"); err != nil {
		t.Fatal(err)
	}
	size, err := s.Size(ctx, "a/b.txt")
	if err != nil || size != 5 {
		t.Fatalf("size = %d, %v", size, err)
	}
	r, err := s.Get(ctx, "a/b.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	got, _ := io.ReadAll(r)
	if string(got) != "hello" {
		t.Errorf("content = %q", got)
	}
	if _, err := s.Size(ctx, "missing"); err == nil {
		t.Error("missing object must error")
	}
}

func TestS3_EnsureBucketIsIdempotent(t *testing.T) {
	s := newStore(t)
	if err := s.EnsureBucket(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestS3_PresignedPutLetsARunnerUploadDirectly(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	url, err := s.PresignPut(ctx, "run/1/shot.png", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodPut, url, bytes.NewReader([]byte("png-bytes")))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload status = %d", resp.StatusCode)
	}
	if size, err := s.Size(ctx, "run/1/shot.png"); err != nil || size != 9 {
		t.Errorf("size = %d, %v", size, err)
	}

	// a presigned URL is bound to its key: reusing it for another object fails
	other := bytes.Replace([]byte(url), []byte("run/1/shot.png"), []byte("run/1/other.png"), 1)
	req, _ = http.NewRequest(http.MethodPut, string(other), bytes.NewReader([]byte("x")))
	resp, err = http.DefaultClient.Do(req)
	if err == nil {
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Error("a presigned URL must not authorize a different key")
		}
	}
}

func TestS3_Delete(t *testing.T) {
	ctx := context.Background()
	s := newStore(t)
	_ = s.Put(ctx, "x", bytes.NewReader([]byte("1")), 1, "text/plain")
	if err := s.Delete(ctx, "x"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Size(ctx, "x"); err == nil {
		t.Error("object still there")
	}
}
