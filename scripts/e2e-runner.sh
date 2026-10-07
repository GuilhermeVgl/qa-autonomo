#!/bin/sh
# E2E do runner (Chromium real contra fixtures/sample-app) num container Playwright, como no CI.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
docker run --rm -v "$root":/repo:ro mcr.microsoft.com/playwright:v1.63.0-noble sh -c '
  mkdir -p /work && cd /repo && tar cf - --exclude=node_modules --exclude=dist runner fixtures 2>/dev/null | tar xf - -C /work
  cd /work/runner && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run test:e2e'
