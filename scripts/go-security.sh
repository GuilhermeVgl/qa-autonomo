#!/bin/sh
# golangci-lint + govulncheck + gosec (CI da seção 15) num container, com o código copiado para dentro dele.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
docker run --rm -v "$root/control-plane":/src:ro golangci/golangci-lint:latest sh -c '
  mkdir /app && cd /src && tar cf - . 2>/dev/null | tar xf - -C /app && cd /app && golangci-lint run ./...'
docker run --rm -v "$root/control-plane":/src:ro golang:1 sh -c '
  mkdir /app && cd /src && tar cf - . 2>/dev/null | tar xf - -C /app && cd /app
  go install golang.org/x/vuln/cmd/govulncheck@latest >/dev/null 2>&1 && govulncheck ./... 2>&1 | grep -E "affected|Vulnerability #" || true
  go install github.com/securego/gosec/v2/cmd/gosec@latest >/dev/null 2>&1 && gosec -exclude-generated ./... 2>&1 | grep -E "Issues|\[/app" || true'
