#!/bin/sh
# Testes Go (Postgres/MinIO reais via testcontainers) num container, com o código copiado para dentro dele.
# Rodar direto no diretório montado fica muito lento no macOS (Desktop sincronizado com iCloud/Spotlight).
# Uso: scripts/go-test.sh [args do go test]   (padrão: -p 2 ./...)
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
args="${*:--p 2 ./...}"
docker run --rm -v "$root/control-plane":/src:ro -v /var/run/docker.sock:/var/run/docker.sock \
  -e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal -e TESTCONTAINERS_RYUK_DISABLED=true golang:1 sh -c "
  mkdir /app && cd /src && tar cf - . 2>/dev/null | tar xf - -C /app
  cd /app && go test $args"
