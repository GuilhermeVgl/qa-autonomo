# Go não está instalado localmente: roda tudo via Docker (ver CLAUDE.md, seção 14).
DOCKER_GO = docker run --rm -v "$(CURDIR)":/app -w /app -v /var/run/docker.sock:/var/run/docker.sock \
  -e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal -e TESTCONTAINERS_RYUK_DISABLED=true golang:1

test:
	../scripts/go-test.sh
vet:
	$(DOCKER_GO) sh -c 'test -z "$$(gofmt -l .)" && go vet ./...'
sqlc:
	docker run --rm -v "$(CURDIR)":/src -w /src sqlc/sqlc generate
