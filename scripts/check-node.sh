#!/bin/sh
# Roda as checagens de um pacote Node (web ou runner) num container Linux, como no CI.
# Evita a lentidão de node_modules novos no macOS (Spotlight/iCloud/Gatekeeper). Uso: scripts/check-node.sh web [comando...]
set -eu
pkg="$1"; shift
cmd="${*:-npx tsc --noEmit && npx eslint . && npx vitest run && npm audit}"
docker run --rm -v "$(cd "$(dirname "$0")/.." && pwd)/$pkg":/src:ro node:24 sh -c "
  mkdir /app && cd /src && tar cf - --exclude=node_modules --exclude=dist . 2>/dev/null | tar xf - -C /app
  cd /app && npm ci --no-audit --no-fund >/dev/null 2>&1 && $cmd"
