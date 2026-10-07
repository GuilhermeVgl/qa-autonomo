# CLAUDE.md — QA Autônomo (nome provisório)

> Spec viva do projeto. É a fonte da verdade para humanos e agentes.
> Toda decisão, descoberta ou armadilha ("hurdle") encontrada vira uma linha aqui **no mesmo commit** que a originou.
> Versão: v1 · 2026-10-01

---

## 1. Visão geral

**Problema:** times enxutos, sem QA dedicado, não testam de forma sistemática. Bugs chegam à produção.

**Solução:** um agente de IA que **explora a aplicação sozinho**, desenha um **grafo** dela (telas, endpoints e ações), cruza esse grafo com as **especificações** e **testa** os nós cobertos. Tudo fica visível ao vivo no grafo, com histórico completo por nó, bugs deduplicados e relatório por execução.

**Contexto:** uso interno na KPMG primeiro, implantado na infra interna. A arquitetura já nasce pronta para virar SaaS (control plane hospedado e multi-tenant, runners na rede de cada cliente) sem reescrita.

**Fora de escopo (por enquanto):** apps desktop, apps mobile nativos, testes de segurança (virão como um executor futuro), exportação de bugs para Azure DevOps/Jira.

---

## 2. Como trabalhamos (XP com IA)

- **Humano decide o quê e o porquê; o agente propõe o como.** Em caso de dúvida de produto, o agente pergunta, não presume.
- **TDD.** Teste primeiro. Nenhum código de produção sem teste que o justifique.
- **Small releases.** Todo commit passa no CI e está pronto para produção. Nada de branch longa.
- **Refatoração contínua.** Refatorar em pequenos passos, sempre com testes verdes. Nunca "cirurgia" grande.
- **Freio no over-engineering.** Solução mais simples que resolve o problema de hoje. Sem frameworks pesados (nada de LangChain e similares), sem abstração especulativa. Exceção: os pontos de extensão listados na seção 4.3.
- **Segurança é hábito, não fase.** Cada fatia trata a segurança do que introduz.
- **Atualize este arquivo.** Descobriu um hurdle, tomou uma decisão, mudou um padrão: registre aqui (seções 13 e 14).

---

## 3. Glossário do domínio

| Termo | Significado |
|---|---|
| **Organização** | Dono dos dados. Hoje existe só uma (KPMG); no SaaS, uma por cliente. |
| **Projeto** | Uma aplicação a ser testada. |
| **Ambiente** | Uma instância da aplicação (ex.: homologação), com URL base, escopo permitido, credenciais e política de ações destrutivas. |
| **Spec** | Documento de especificação versionado: texto, documento convertido em texto ou OpenAPI/Swagger. |
| **Requisito** | Unidade testável extraída de uma spec, com ID estável (`REQ-012`) e criticidade. |
| **Grafo** | Mapa da aplicação por ambiente: **nós** (estados) e **arestas** (ações). Versionado. |
| **Nó** | Um estado: página, modal, endpoint de API ou comando de terminal. Identificado por *fingerprint*. |
| **Aresta** | Uma ação que leva de um nó a outro: clicar, preencher, chamar endpoint. |
| **Papel** | Perfil de usuário da aplicação testada (admin, operador...). A exploração roda por papel. |
| **Run (execução)** | Uma execução, do tipo **exploração** (remapeia tudo) ou **regressão** (reusa o grafo, testa nós cobertos e re-explora só onde mudou). |
| **Passo** | Uma ação executada dentro de um run, ligada a um nó/aresta, com entrada, resultado e evidências. |
| **Evidência** | Print, vídeo, trace do Playwright, HAR, request/response, log de console ou saída de terminal. |
| **Cobertura** | Ligação requisito ↔ nó: 🟢 coberto · ⚪ sem spec · 🟠 pendência. |
| **Pendência** | Pergunta do agente ao humano, ancorada no grafo, quando spec e aplicação divergem ou algo não é encontrado. |
| **Conhecimento** | O que o projeto aprendeu: respostas a pendências e falsos positivos. Entra no contexto das próximas execuções. |
| **Bug** | Defeito deduplicado por fingerprint, com ciclo de vida próprio, independente dos runs. |
| **Runner** | Processo que executa jobs. Fala com o control plane só por conexão de saída. |
| **Executor** | Canal de teste dentro do runner: `browser`, `mobile_web`, `api`, `terminal`. |

---

## 4. Arquitetura

### 4.1 Componentes

```
┌──────────────────────── Control plane (Go) ────────────────────────┐
│ API HTTP · auth (OIDC) · specs/requisitos · grafo · runs · bugs     │
│ pendências · conhecimento · agendador/fila (River) · LLM gateway    │
│ SSE para a UI · auditoria                                           │
└───────▲───────────────────────────▲────────────────────────────────┘
        │ HTTPS (UI)                │ HTTPS de saída (runner → control plane)
┌───────┴────────┐     ┌────────────┴──────── Runner (TypeScript) ────────┐
│ Web (React +   │     │ loop do agente · executores: browser, mobile_web, │
│ React Flow)    │     │ api, terminal (sandbox) · upload de evidências    │
└────────────────┘     └───────────────────────────────────────────────────┘
        PostgreSQL 18 · object storage (MinIO / Azure Blob / S3)
```

**Go decide, TypeScript executa.** O control plane guarda o estado e orquestra. O runner é stateless e descartável.

### 4.2 Modos de implantação

| Modo | Quando | Como |
|---|---|---|
| **Interno (single-org)** | Agora | `docker compose up` na rede da KPMG. Uma organização. Runners na mesma rede. |
| **SaaS (multi-tenant)** | Futuro | Control plane hospedado. Runners instalados na rede de cada cliente, registrados com token, conectando só de saída (modelo GitHub Actions self-hosted runner). |

A diferença entre os modos é **configuração**, não código. Regras que garantem isso desde o dia 1:

1. `organization_id` em toda tabela de domínio e em toda query, mesmo com uma organização só.
2. Autenticação via OIDC (Entra ID na KPMG), com usuários locais apenas em dev.
3. Runner nunca recebe conexão de entrada e nunca acessa o banco. Só a API `/runner/v1`.
4. Runner nunca vê credenciais de LLM: chama o LLM gateway do control plane.
5. Evidências em object storage, nunca em disco local.
6. Toda configuração por variável de ambiente (12 factors).

### 4.3 Pontos de extensão (as únicas abstrações permitidas de saída)

- **Executor** (runner): `browser`, `mobile_web`, `api`, `terminal`. Segurança entra depois como mais um.
- **Provedor de LLM** (control plane): `azure_openai`, `openai_compatible` (vLLM, Ollama).
- **Fonte de spec**: `text`, `document`, `openapi`.
- **Storage**: `s3` (inclui MinIO), `azure_blob`.
- **Integração de bugs** (futuro): Azure DevOps, Jira. Não implementar agora.

---

## 5. Stack

| Parte | Escolha |
|---|---|
| Control plane | Go (última estável), `net/http` da stdlib (roteamento nativo), `pgx`, `sqlc`, migrações com `goose`, fila e cron com **River** (sobre Postgres, sem Redis), `coreos/go-oidc` |
| CLI de CI (`qactl`) | Go, no mesmo módulo do control plane, distribuída como binário |
| Runner | Node LTS + TypeScript `strict`, Playwright, SDK `openai` apontado para o gateway, `zod` para schemas |
| Web | React + Vite + TypeScript, **React Flow** (`@xyflow/react`) para o grafo, TanStack Query, atualização ao vivo via SSE |
| Banco | PostgreSQL 18 (UUIDv7 como PK) |
| Object storage | MinIO em dev/compose; Azure Blob na KPMG |
| Sandbox de terminal | Container efêmero por job; gVisor depois |
| Tempo real | Postgres `LISTEN/NOTIFY` → SSE (funciona com várias instâncias) |

---

## 6. Estrutura do monorepo

```
/
├── CLAUDE.md
├── control-plane/              # Go
│   ├── cmd/server/             # API + workers River
│   ├── cmd/qactl/              # CLI para CI
│   ├── internal/               # pacotes por domínio, não por camada
│   │   ├── auth/  org/  project/  environment/  spec/  graph/
│   │   ├── run/  bug/  pendency/  knowledge/  report/
│   │   ├── runnerapi/  llm/  storage/  events/  audit/  config/
│   └── db/{migrations,queries}/
├── runner/                     # TypeScript
│   └── src/{protocol,agent,executors/{browser,mobile_web,api,terminal},fingerprint,evidence}/
├── web/                        # React
├── fixtures/sample-app/        # app-alvo com bugs plantados, usado para testar o próprio agente
├── deploy/compose/             # docker-compose.yml
└── docs/adr/                   # decisões longas (as curtas ficam na seção 13)
```

---

## 7. Modelo de dados (v1)

Toda tabela de domínio tem `id uuid (v7)`, `organization_id`, `created_at`, `updated_at`.

| Tabela | Campos principais |
|---|---|
| `organizations` | name, slug |
| `users` / `memberships` | email, oidc_subject · role (`owner`, `member`, `viewer`) |
| `projects` | name |
| `environments` | project_id, name, base_url, allowed_hosts[], destructive_policy (`block`, `confirm`, `allow`), is_production (bool, bloqueia execução) |
| `credentials` | environment_id, app_role, kind (`login`, `api_token`), payload_encrypted |
| `specs` | project_id, version, source_type, title, raw_storage_key, extracted_text |
| `requirements` | spec_id, key (`REQ-012`), text, criticality (`critical`, `high`, `normal`), status |
| `graphs` | project_id, environment_id, version, source_run_id |
| `nodes` | graph_id, kind (`page`, `modal`, `endpoint`, `command`), fingerprint, label, app_roles[], metadata jsonb |
| `edges` | graph_id, from_node_id, to_node_id, action jsonb, app_roles[] |
| `requirement_links` | requirement_id, node_id, confidence, source (`agent`, `human`) |
| `runs` | project_id, environment_id, type (`exploration`, `regression`), trigger (`manual`, `schedule`, `ci`), status, budget jsonb, started_at, finished_at, summary jsonb |
| `run_steps` | run_id, node_id, edge_id, executor, input_masked jsonb, expected, actual, result (`pass`, `fail`, `error`, `skipped`), started_at, finished_at |
| `artifacts` | run_step_id, kind (`screenshot`, `video`, `trace`, `har`, `console`, `http`, `stdout`), storage_key, size |
| `pendencies` | run_id, requirement_id, node_id (nullable), question, answer, answered_by, status (`open`, `answered`, `dismissed`) |
| `knowledge_entries` | project_id, content, origin (`pendency`, `false_positive`, `manual`), origin_id |
| `bugs` | project_id, fingerprint (único por projeto), title, status, severity, requirement_id, node_id, first_seen_run_id, last_seen_run_id |
| `bug_occurrences` | bug_id, run_id, run_step_id |
| `schedules` | project_id, environment_id, run_type, cron, enabled |
| `api_tokens` | project_id, name, token_hash, scopes, last_used_at |
| `runners` | name, token_hash, labels[], last_seen_at, version |
| `llm_usage` | run_id, task, provider, model, tokens_in, tokens_out, cost |
| `audit_log` | actor, action, target, payload, at |

---

## 8. Fluxos principais

### 8.1 Ingestão de spec
1. Usuário envia texto, documento ou OpenAPI. O original vai para o storage.
2. `text`/`document` → LLM extrai requisitos com ID, texto e criticidade.
3. `openapi` → parser **determinístico** gera nós `endpoint` e requisitos de contrato (status, schema). O LLM entra só para inferir regras e ordem de chamadas.
4. Nova versão da spec gera um **diff de requisitos** (novo, alterado, removido), que marca o que retestar.

### 8.2 Exploração
1. Para cada papel com credencial no ambiente, o runner autentica e navega dentro de `allowed_hosts`.
2. Cada estado novo vira nó (via fingerprint, seção 9); cada ação vira aresta. Eventos são enviados em lote ao control plane e aparecem ao vivo no grafo.
3. Para em: orçamento de tempo, custo, profundidade ou ausência de estados novos.
4. Ações destrutivas seguem `destructive_policy` do ambiente.

### 8.3 Cruzamento spec × grafo
- O agente liga requisitos a nós (`requirement_links`) com confiança.
- Requisito sem nó correspondente ou com divergência → **pendência** ancorada no grafo.
- Pendências **não bloqueiam** o run; o requisito fica 🟠 até ser respondido.
- Resposta do humano (apontar o nó ou explicar) vira `knowledge_entry` e `requirement_link` com `source = human`.

### 8.4 Execução (teste)
- Testa os nós 🟢. Cada passo grava entrada (mascarada), esperado, obtido, resultado e evidências.
- O histórico de cada nó é a lista de `run_steps` daquele nó ao longo dos runs.

### 8.5 Bugs
- Falha gera fingerprint = hash(nó + requisito + assinatura normalizada do erro).
- Fingerprint existente → nova `bug_occurrence`; novo → novo `bug`.
- Card do run mostra bugs 🔴 novos, 🟠 recorrentes e 🟢 corrigidos (falhavam antes e passaram neste run).
- Status: `new` → `confirmed` → `fixed`, além de `false_positive` (gera conhecimento) e `reopened`.
- Botão **Reproduzir**: cria um run de regressão restrito ao caminho do bug.

### 8.6 Gatilhos
Os três criam um run pela mesma função de domínio:
- **Manual:** UI.
- **Agendado:** `schedules` → job cron do River. Padrão sugerido: exploração noturna.
- **CI:** `qactl run --project X --env hml --type regression --wait` com token de projeto. Saída: exit code (falha se requisito `critical` falhar), JUnit XML e link do run.
- **Lock por ambiente:** um run ativo por ambiente; os demais entram na fila.

### 8.7 Relatório do run
Página do run com: resumo (cobertura, pass/fail por requisito, bugs novos/recorrentes/corrigidos, custo e duração), grafo do momento e links para evidências. Exportação em PDF fica para depois.

---

## 9. Equivalência de estados (fingerprint de nó)

Evitar explosão de estados é crítico.
- **page/modal:** padrão de rota (IDs e UUIDs normalizados para `:id`) + hash da estrutura do DOM (tags, roles ARIA, formulários e campos; **sem** textos e dados) + papel.
- **endpoint:** método + path template (`GET /orders/{id}`).
- **command:** comando normalizado.
- Mesma tela com dados diferentes = mesmo nó. Alterações na regra de fingerprint exigem teste com `fixtures/sample-app`.

---

## 10. Protocolo control plane ↔ runner (`/runner/v1`)

Versionado. O runner só faz requisições de saída, autenticado com token de runner.

| Endpoint | Função |
|---|---|
| `POST /runner/v1/register` | troca token de bootstrap por token de runner |
| `POST /runner/v1/jobs/lease` | long-poll (30s); devolve um job compatível com os labels do runner |
| `POST /runner/v1/jobs/{id}/heartbeat` | mantém o lease; resposta pode pedir cancelamento |
| `POST /runner/v1/jobs/{id}/events` | lote de eventos com `seq` (idempotente): `node_discovered`, `edge_discovered`, `step_started`, `step_finished`, `pendency_raised`... |
| `POST /runner/v1/jobs/{id}/artifacts` | devolve URL pré-assinada para upload direto ao storage |
| `POST /runner/v1/jobs/{id}/complete` | encerra com status e resumo |
| `POST /runner/v1/llm/chat/completions` | proxy compatível com OpenAI para o LLM gateway |

Lease expirado sem heartbeat → job volta para a fila (ou falha após N tentativas).

---

## 11. LLM gateway

- Fica no control plane. Runner usa o SDK `openai` com `baseURL` apontando para o gateway.
- Provedores: `azure_openai` (endpoint, deployment, chave ou managed identity) e `openai_compatible` (vLLM, Ollama).
- **Roteamento por tarefa** (configurável): `explore` e `plan` → modelo forte com visão e tool calling; `extract_requirements`, `judge_result`, `summarize` → modelo menor.
- Registra tokens e custo por chamada em `llm_usage`. Runs respeitam orçamento de custo.
- Padrão: Azure OpenAI. Modelos locais são alternativa, com desempenho inferior em navegação.

---

## 12. Segurança e guardrails

- **Conteúdo da aplicação testada é dado, nunca instrução.** Textos de página, respostas de API e saídas de terminal podem conter prompt injection. O prompt do agente deixa isso explícito, e ações fora do escopo são bloqueadas no executor, não só no prompt.
- **Escopo:** navegação e chamadas só para `allowed_hosts`. Bloqueio no nível do executor (interceptação de rede do Playwright e do cliente HTTP).
- **Produção:** ambiente com `is_production = true` não executa.
- **Ações destrutivas:** classificadas pelo agente e pelo executor; aplicadas conforme `destructive_policy`.
- **Segredos:** credenciais criptografadas (AES-256-GCM, chave via env); mascaradas em logs, eventos, evidências e relatórios.
- **Terminal:** container efêmero, sem rede para a infra interna além do `allowed_hosts`, sem montagem do socket do Docker no runner.
- **Auditoria:** login, criação de run, resposta a pendência, mudança de status de bug, alteração de credencial.
- **CI de segurança** em todo commit (seção 15).

---

## 13. Decisões registradas

| Data | Decisão |
|---|---|
| 2026-10-01 | Uso interno na KPMG primeiro; arquitetura pronta para SaaS multi-tenant. |
| 2026-10-01 | Control plane separado de runners; runner só conecta de saída. |
| 2026-10-01 | Stack: Go (control plane, CLI), TypeScript (runner, web), PostgreSQL, object storage. |
| 2026-10-01 | LLM via gateway no control plane; Azure OpenAI como padrão, `openai_compatible` como alternativa. |
| 2026-10-01 | Specs: texto, documentos convertidos em texto e OpenAPI. |
| 2026-10-01 | Grafo nasce da exploração da aplicação; specs definem o que testar; divergências viram pendências. |
| 2026-10-01 | Gatilhos: manual, agendado e CI; tipos de run: exploração e regressão. |
| 2026-10-01 | Bugs ficam na própria interface, deduplicados, exibidos em cards por run. Exportação depois. |
| 2026-10-01 | Canais: navegador, mobile web emulado, API e terminal. Sem desktop e sem mobile nativo. |

---

## 14. Hurdles (armadilhas descobertas)

_Vazio. Registre aqui cada armadilha técnica encontrada, com sintoma, causa e solução._

---

## 15. Testes e CI

Todo commit roda, e precisa passar:

| Parte | Checks |
|---|---|
| Go | `go test ./...` (Postgres real via testcontainers), `golangci-lint`, `govulncheck`, `gosec` |
| Runner | `tsc --noEmit`, `eslint`, `vitest`, `npm audit` |
| Web | `tsc --noEmit`, `eslint`, `vitest` |
| E2E | runner contra `fixtures/sample-app` com **respostas de LLM gravadas** (determinístico). Os bugs plantados no app-alvo precisam ser encontrados. |

- Testes de LLM real ficam em suíte separada (manual/noturna), nunca bloqueiam o CI.
- Meta: CI completo abaixo de 3 minutos.

---

## 16. Configuração (variáveis de ambiente)

| Variável | Uso |
|---|---|
| `DATABASE_URL` | PostgreSQL |
| `STORAGE_DRIVER` / `STORAGE_*` | `s3` ou `azure_blob` e credenciais |
| `ENCRYPTION_KEY` | chave de criptografia dos segredos |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | SSO |
| `LLM_PROVIDER`, `LLM_ENDPOINT`, `LLM_API_KEY`, `LLM_MODEL_<TAREFA>` | gateway de LLM |
| `RUNNER_BOOTSTRAP_TOKEN` | registro de runners |
| `CONTROL_PLANE_URL`, `RUNNER_TOKEN`, `RUNNER_LABELS` | runner |
| `MULTI_TENANT` | `false` agora; `true` no modo SaaS |

Logs estruturados (JSON) em stdout. Nada de arquivo de config obrigatório.

---

## 17. Roadmap em fatias

Cada fatia vai para produção interna antes da próxima.

0. **Fundação:** monorepo, compose (Postgres, MinIO, control plane, runner, web), CI completo, health checks, login OIDC + usuário local em dev, `organization_id` em tudo.
1. **Projetos, ambientes e specs de texto:** CRUD, credenciais criptografadas, extração de requisitos.
2. **Runner + exploração no navegador:** protocolo `/runner/v1`, executor `browser`, fingerprint de nós, grafo persistido e ao vivo no React Flow.
3. **Cruzamento e pendências:** requirement_links, camada de cobertura no grafo, pendências e conhecimento.
4. **Execução e histórico:** run_steps, evidências, histórico por nó.
5. **Bugs e relatório do run:** fingerprint, dedup, cards por run, Reproduzir.
6. **Gatilhos:** agendamento, `qactl`, JUnit XML, lock por ambiente.
7. **API:** ingestão de OpenAPI e executor `api`.
8. **Mobile web:** executor `mobile_web` (emulação de dispositivo).
9. **Terminal:** executor `terminal` em sandbox.

**Depois:** exportação para Azure DevOps/Jira, relatório em PDF, modo SaaS multi-tenant, executor de segurança.

---

## 18. Questões em aberto

- Nome do produto.
- Aprovação interna da KPMG (uso de IA, dados de clientes em testes, hospedagem).
- Onde roda na KPMG (Azure? Kubernetes interno?) e qual storage é aprovado.
- Política de retenção de evidências (vídeos e traces ocupam muito espaço).
- Política padrão de ações destrutivas para ambientes novos.
- Limites padrão de orçamento por run (tempo, custo, profundidade).

---

## 19. Convenções de código

- **Go:** pacotes por domínio; erros com contexto (`fmt.Errorf("...: %w", err)`); SQL só via `sqlc`; toda query filtra por `organization_id`; nada de ORM.
- **TypeScript:** `strict`; validar com `zod` tudo que cruza fronteira (protocolo, saída de LLM); sem `any`.
- **Commits:** pequenos, mensagem no imperativo, com teste junto.
- **Idioma:** código e identificadores em inglês; documentação e UI em português.
