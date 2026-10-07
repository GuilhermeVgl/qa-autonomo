# QA Autônomo (nome provisório)

Um agente de IA que explora a aplicação sozinho, desenha o grafo dela (telas e ações), cruza o grafo com as
especificações e testa os nós cobertos. Bugs ficam deduplicados, com histórico por nó, evidências e relatório por run.

A fonte da verdade do projeto é o [CLAUDE.md](CLAUDE.md) (visão, arquitetura, decisões e armadilhas).

## Partes

| Pasta | O que é |
|---|---|
| `control-plane/` | Go: API, auth (OIDC), specs, grafo, runs, bugs, agendador, gateway de LLM, `qactl` |
| `runner/` | TypeScript: executor de navegador (Playwright), exploração e regressão. Só conexões de saída |
| `web/` | React: login (OIDC/dev), configuração, grafo ao vivo (React Flow), cobertura, pendências, bugs, relatório do run, histórico por nó |
| `fixtures/sample-app/` | App web e API com bugs plantados, usado para testar o próprio agente |
| `fixtures/sample-cli/` | CLI com bug plantado, para testar o executor de terminal |
| `deploy/compose/` | `docker-compose.yml` de desenvolvimento |

## Subir tudo (desenvolvimento)

```sh
cd deploy/compose
docker compose up -d --build
```

- API em `http://localhost:8083` (modo `AUTH_MODE=dev`: token `dev:seu@email`), UI em `http://localhost:3010`,
  console do MinIO em `http://localhost:9090`. Portas escolhidas para não colidir com outros projetos locais
  (o Evolution API do coletadoc usa a 8082); ajuste só o lado esquerdo de `ports` no compose.
- Para ligar o LLM, exporte `LLM_PROVIDER`, `LLM_ENDPOINT`, `LLM_API_KEY` e `LLM_MODEL` antes do `up`
  (sem LLM, extração de requisitos, cruzamento e exploração guiada ficam desligados).
- Variáveis de ambiente: seção 16 do CLAUDE.md.

## Demo com o ColetaDoc e LLM local

Passo a passo completo (modelo local, cadastro, exploração, cruzamento, regressão e roteiro de apresentação): [docs/coletadoc-demo.md](docs/coletadoc-demo.md).

## Testar

```sh
scripts/go-test.sh                 # Go (Postgres e MinIO reais via testcontainers), dentro de um container
scripts/go-security.sh             # golangci-lint, govulncheck e gosec
scripts/check-node.sh web          # tsc, eslint, vitest e npm audit
scripts/check-node.sh runner       # idem para o runner
scripts/e2e-runner.sh              # runner (Chromium real) contra o app de exemplo, com respostas de LLM gravadas
```

Os scripts copiam o código para dentro do container: no macOS, rodar direto sobre o diretório montado fica muito
lento, principalmente se o repositório estiver em uma pasta sincronizada pelo iCloud (veja a seção 14 do CLAUDE.md).

## Usar no CI

```sh
export QACTL_SERVER=https://qa.exemplo.com QACTL_TOKEN=qat_...   # token de projeto
qactl run --env hml --type regression --wait --junit resultado.xml
```

Código de saída: `0` ok, `1` requisito `critical` falhou (ou o run falhou), `2` uso/autenticação, `3` timeout.

## Runner de terminal

Ambientes `terminal` testam um CLI dentro de um runner efêmero, **sem rede** (cada comando roda num namespace de rede
novo). Quem implanta sobe um runner por job, com a imagem que contém o CLI e os labels `terminal` e
`image:<imagem do ambiente>` (`RUNNER_LABELS=terminal,image:registry.exemplo/cli:1.0`). O container precisa permitir
user namespaces (`unshare`); com o seccomp padrão do Docker ele não permite, e o runner recusa o job em vez de rodar
sem isolamento. Em desenvolvimento: `--security-opt seccomp=unconfined`.


➜  ~ docker model pull ai/qwen2.5:7B-Q4_K_M
Downloaded 4.68GB of 4.68GB
Model pulled successfully
➜  ~ docker model configure --context-size=16384 ai/qwen2.5:7B-Q4_K_M
➜  ~ docker model run ai/qwen2.5:7B-Q4_K_M 'Responda só com JSON: {"ok": true}'
{"ok": true}
➜  ~ cd projetos 
➜  projetos ls
cobra     coletadoc rentix    todo-app
➜  projetos cd coletadoc 
mise WARN  missing: ruby@3.4.10
➜  coletadoc git:(main) ✗ ls
app                config             docker             Dockerfile.dev     lib                package.json       Rakefile           storage            vendor
bin                config.ru          docker-compose.yml Gemfile            log                Procfile.dev       README.md          test               yarn.lock
CLAUDE.md          db                 Dockerfile         Gemfile.lock       node_modules       public             script             tmp
➜  coletadoc git:(main) ✗ echo 'RAILS_DEVELOPMENT_HOSTS=host.docker.internal' >> .env
➜  coletadoc git:(main) ✗ docker compose up -d postgres minio minio-init web jobs
[+] Running 6/6
 ✔ Network coletadoc_default         Created                                                                                                                                0.0s 
 ✔ Container coletadoc-minio-1       Healthy                                                                                                                                6.5s 
 ✔ Container coletadoc-postgres-1    Healthy                                                                                                                                6.5s 
 ✔ Container coletadoc-minio-init-1  Started                                                                                                                                6.6s 
 ✔ Container coletadoc-jobs-1        Started                                                                                                                                6.7s 
 ✔ Container coletadoc-web-1         Started                                                                                                                                6.8s 
➜  coletadoc git:(main) ✗ curl -s -o /dev/null -w "%{http_code}\n" -H "Host: host.docker.internal:3002" http://localhost:3002/up

200
➜  coletadoc git:(main) ✗ docker compose exec web bin/rails runner 'User.create!(email: "qa@teste.dev", password: "Senha-QA-12345", organization_name: "QA Teste")'

➜  coletadoc git:(main) ✗ docker model run ai/qwen2.5:7B-Q4_K_M 'Responda só com JSON: {"ok": true}'                                                               
{"ok": true}
mise WARN  missing: ruby@3.4.10                                                                                                                                                  
➜  coletadoc git:(main) ✗ 





