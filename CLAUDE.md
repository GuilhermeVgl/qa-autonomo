# CLAUDE.md — QA Autônomo (nome provisório)

> Spec viva do projeto. É a fonte da verdade para humanos e agentes.
> Toda decisão, descoberta ou armadilha ("hurdle") encontrada vira uma linha aqui **no mesmo commit** que a originou.
> Versão: v1 · 2026-10-01

---

## 1. Visão geral

**Problema:** times enxutos, sem QA dedicado, não testam de forma sistemática. Bugs chegam à produção.

**Solução:** um agente de IA que **explora a aplicação sozinho**, desenha um **grafo** dela (telas, endpoints e ações), cruza esse grafo com as **especificações** e **testa** os nós cobertos. Tudo fica visível ao vivo no grafo, com histórico completo por nó, bugs deduplicados e relatório por execução.

**Contexto:** uso interno na KPMG primeiro, implantado na infra interna. A arquitetura já nasce pronta para virar SaaS (control plane hospedado e multi-tenant, runners na rede de cada cliente) sem reescrita.

**Fora de escopo (por enquanto):** apps desktop, apps mobile nativos, teste de invasão (pentest) e testes de segurança aprofundados (as verificações clássicas, como XSS, CSRF e SQL injection, já rodam dentro da exploração e da regressão: seção 13), exportação de bugs para Azure DevOps/Jira.

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

- **Executor** (runner): `browser`, `mobile_web`, `api`, `terminal`. As verificações clássicas de segurança não são um executor: rodam dentro do `browser` (e do `mobile_web`), na exploração e na regressão.
- **Provedor de LLM** (control plane): `azure_openai`, `openai_compatible` (vLLM, Ollama).
- **Fonte de spec**: `text`, `document`, `openapi`, `auto` (gerada do mapa, seção 13).
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
| `credentials` | environment_id, app_role, kind (`login`, `api_token`, `session`), payload_encrypted |
| `specs` | project_id, version, source_type (`text`, `document`, `openapi`, `auto`), title, raw_storage_key, extracted_text |
| `requirements` | spec_id, key (`REQ-012`), text, criticality (`critical`, `high`, `normal`), status |
| `graphs` | project_id, environment_id, version, source_run_id |
| `nodes` | graph_id, kind (`page`, `modal`, `endpoint`, `command`), fingerprint, label, app_roles[], metadata jsonb |
| `edges` | graph_id, from_node_id, to_node_id, action jsonb, app_roles[] |
| `requirement_links` | requirement_id, node_id, confidence, source (`agent`, `human`) |
| `runs` | project_id, environment_id, type (`exploration`, `regression`), trigger (`manual`, `schedule`, `ci`), status, budget jsonb, started_at, finished_at, summary jsonb |
| `run_steps` | run_id, node_id, edge_id, executor, input_masked jsonb, expected, actual, result (`pass`, `fail`, `error`, `skipped`), started_at, finished_at, security jsonb (`{check, severity, scope}`; nulo = passo funcional) |
| `artifacts` | run_step_id, kind (`screenshot`, `video`, `trace`, `har`, `console`, `http`, `stdout`), storage_key, size |
| `pendencies` | run_id, requirement_id, node_id (nullable), question, answer, answered_by, status (`open`, `answered`, `dismissed`) |
| `knowledge_entries` | project_id, content, origin (`pendency`, `false_positive`, `manual`), origin_id |
| `bugs` | project_id, fingerprint (único por projeto), title, status, severity, category (`functional`, `security`), security_check, requirement_id, node_id, first_seen_run_id, last_seen_run_id |
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
- Achados das verificações de segurança são bugs de categoria `security`, com impressão digital `hash(check + escopo)` (independente de usuário e de tela) e corrigidos só pelo passe do mesmo check (seção 13).
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
- **Verificações de segurança** só **leem**: as injeções vão por GET nos parâmetros de endereço e em formulários de busca, o redirecionamento nunca é seguido, o escopo (`allowed_hosts`) vale também para as chamadas que não passam pelo navegador, e nada é enviado por POST, mesmo com a política `allow`. Logout e ações destrutivas nunca viram alvo de injeção.
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
| 2026-10-01 | OpenAPI (`source_type=openapi`, 3.x em JSON ou YAML): parser determinístico, sem LLM (`internal/openapi`). Segue só `$ref` locais (remotos, de arquivo ou pendentes dão 400, nada é buscado), corta ciclos e profundidade, limita a 2 MiB e 2000 operações. Cada operação com 2xx documentado vira um requisito de contrato cuja chave é `MÉTODO /path/{param}` (estável entre versões; o texto embute um hash do schema, então mudar o contrato marca o requisito como `changed`); operações sem 2xx são puladas e devolvidas em `skipped`. Gravidade: `high` para POST/PUT/PATCH/DELETE, `normal` para o resto. Parte LLM (inferir regras e ordem de chamadas) não existe ainda. |
| 2026-10-01 | Nós `endpoint` (fingerprint = método + path template, seção 9) são criados no último grafo de cada ambiente do projeto (um primeiro grafo se não houver) já ligados ao requisito com confiança 1; a cada nova versão da spec os links `agent` dos endpoints são refeitos, então operações removidas deixam de estar cobertas (e testadas) mas o nó e o histórico ficam. Como esses nós vêm da spec e não da exploração, toda exploração nova copia os nós `endpoint` e seus links do grafo anterior. |
| 2026-10-01 | Executor `api` (runner): regressão de nós `endpoint` por HTTP puro. Valida o status do contrato e o corpo contra o JSON Schema (ajv); a bearer vem do 1º `api_token` do ambiente; só chama hosts em `allowed_hosts` e não segue redirects; métodos que mudam dados (POST/PUT/PATCH/DELETE) são pulados salvo `destructive_policy=allow`, e operações que exigem corpo são sempre puladas (gerar corpos não existe ainda). Evidência: JSON da chamada e da resposta (sem cabeçalhos de requisição, logo sem o token). O job leva `targets[].kind = page|endpoint`; o servidor já substitui os parâmetros de path por exemplos (`example`, `default`, `enum`, tipo). |
| 2026-10-01 | `mobile_web` é propriedade do **ambiente** (`environments.device`, ex.: `iPhone 13`, `Pixel 7`, validado contra uma lista fixa de descritores do Playwright): um ambiente "mobile" tem a mesma URL e as próprias credenciais, e grafo, regressões e bugs seguem por ambiente, então não há mistura entre desktop e celular. O runner aplica o descritor (viewport, user agent, toque) em cada contexto e recusa dispositivo desconhecido em vez de cair no desktop; os passos de página saem como `mobile_web`. |
| 2026-10-01 | Executor `terminal` (decidido com o time de produto): descoberta por varredura de `--help` recursiva (`runner/src/executors/terminal` e `runner/src/agent/terminal.ts`); o **runner é o container efêmero** e o orquestrador (Compose, Kubernetes, CI do cliente) sobe um runner por job; a **imagem é informada por ambiente** e a plataforma não mantém imagens; a restrição extra é **sem rede**. Ambiente `kind=terminal` tem `terminal_binary` e `terminal_image` opcional, sem URL (`terminal://<binário>`) e sem hosts. O servidor só entrega o run a runners cujos labels incluem `terminal` e, se houver imagem, `image:<imagem>` (`runs.required_labels`); runs web seguem para qualquer runner. |
| 2026-10-01 | Isolamento do CLI testado: cada comando roda via `unshare --user --map-root-user --net --`, ou seja, num namespace de rede novo (sem rede nem loopback); se o host não permitir user namespaces o runner **falha fechado** e recusa o job. Além disso: sem shell (argumentos literais, nomes só `[A-Za-z0-9._-]` vindos do `--help`), ambiente limpo (nada de tokens do runner), diretório de trabalho descartável, limite de tempo (20 s) e de saída (256 KB). Nós `command` têm fingerprint = binário + caminho de subcomandos; a regressão roda `--help` e confere código de saída 0 e a assinatura estrutural do help (subcomandos e flags, não o texto). Subcomandos com nome destrutivo não são executados sob `block`/`confirm`. Para o container do runner permitir `unshare`, o perfil seccomp padrão do Docker precisa ser relaxado (em dev, `--security-opt seccomp=unconfined`; em produção, um perfil que libere só user namespaces). Resource limits (CPU/memória) e allowlist de binários não foram pedidos e ficam para depois. |
| 2026-10-01 | Bugs ficam na própria interface, deduplicados, exibidos em cards por run. Exportação depois. |
| 2026-10-01 | Canais: navegador, mobile web emulado, API e terminal. Sem desktop e sem mobile nativo. |
| 2026-10-01 | Auth: o control plane valida ID tokens OIDC enviados como `Bearer` (fluxo de login/PKCE fica na UI). `AUTH_MODE=dev` aceita tokens `dev:<email>` (usuários locais, só dev). O 1º usuário da organização vira `owner`. |
| 2026-10-01 | Migrações goose embutidas no binário e aplicadas no start; sqlc gera código no pacote do domínio (`make sqlc`), UUIDs como `google/uuid`. |
| 2026-10-01 | Política destrutiva padrão de ambiente novo: `block` (mais seguro). `allowed_hosts` padrão: só o host da `base_url`. Resolve parcialmente a questão em aberto da seção 18. |
| 2026-10-01 | Credenciais: `PUT /environments/{id}/credentials` cifra com AES-256-GCM (`ENCRYPTION_KEY`, base64 de 32 bytes); a API nunca devolve o payload e a auditoria (`credential.upsert`) registra só papel e tipo. |
| 2026-10-01 | Specs: por ora só `source_type=text`; `raw_storage_key` fica nulo até o object storage entrar (documentos/OpenAPI). Cada versão recebe o `status` de cada requisito (`new`/`changed`/`unchanged`) em relação à anterior; removidos vêm só na resposta do ingest. O extrator recebe as keys anteriores para manter IDs estáveis. |
| 2026-10-01 | LLM gateway: `azure_openai` (deployment = modelo da tarefa) e `openai_compatible`; roteamento `LLM_MODEL_<TAREFA>` com fallback `LLM_MODEL`; uso em `llm_usage` (custo ainda 0, sem tabela de preços). Sem `LLM_PROVIDER`, ingestão de spec responde 503. |
| 2026-10-01 | Fila de runs: a própria tabela `runs` (status `queued`→`running`, lease de 60s, `FOR UPDATE SKIP LOCKED`), sem River por enquanto; River entra com agendamento (fatia de gatilhos). O lock por ambiente é garantido pelo banco (índice único parcial `runs_one_running_per_env`). Lease expirado volta para a fila; na 3ª tentativa o run falha. |
| 2026-10-01 | Registro de runner: `RUNNER_BOOTSTRAP_TOKEN` (vazio desativa o registro) troca por token `qar_...` guardado só como hash SHA-256. O token do runner pertence à organização padrão. O job devolve as credenciais do ambiente já decifradas, só nessa chamada autenticada. |
| 2026-10-01 | Eventos do runner são idempotentes por `(run, tentativa, seq)`; lote inválido não aplica nada (transação). Arestas têm `key` estável (`link /orders/:id`) para desduplicar. Nós por papel: o fingerprint inclui o papel (seção 9), então cada nó tem um papel. |
| 2026-10-01 | Exploração atual é um crawler determinístico por links (BFS, até 3 URLs por padrão de rota, orçamento de páginas/profundidade/tempo). O agente guiado por LLM (proxy `/runner/v1/llm/chat/completions`) e ações além de links (formulários, botões) ainda não existem. Evidências (`/artifacts`) dependem do object storage. |
| 2026-10-01 | UI recebe o grafo por SSE de pings `graph_changed` (Postgres `LISTEN/NOTIFY`); o cliente rebusca o grafo. Orçamento padrão de run: 50 páginas, profundidade 4, 600 s (resolve parcialmente a seção 18). |
| 2026-10-01 | Cruzamento spec × grafo roda sob demanda (`POST /environments/{id}/crossref`, última spec × último grafo), com a tarefa de LLM `plan`. O prompt recebe requisitos, nós (como `n1..nN`, nunca UUIDs), e o conhecimento do projeto, tudo marcado como dado; a saída é validada e rejeitada inteira se inválida (502, nada gravado). Rodar de novo troca os links `agent` e preserva os `human`. Disparo automático ao fim da exploração fica para a fatia de gatilhos. |
| 2026-10-01 | Todo requisito sem nó vira pendência (determinístico, mesmo sem o LLM pedir), no máximo uma aberta por requisito; pendência cujo requisito ganhou link é descartada. Responder (`/pendencies/{id}/answer`) com `node_id` cria `requirement_link` `human` (confiança 1); a resposta sempre vira `knowledge_entry` (`origin=pendency`) e é auditada (`pendency.answer`). Cobertura: requisito 🟢 `covered` · 🟠 `pending` (pendência aberta) · `unmatched` (sem link e sem pendência aberta); nó 🟢 `covered` · ⚪ `no_spec`. |
| 2026-10-01 | Limitação conhecida: links apontam para nós de uma versão de grafo; uma nova exploração cria nós novos, então links `human` não migram sozinhos (migrar por fingerprint é trabalho futuro). |
| 2026-10-01 | Login OIDC no web: authorization code + PKCE feito no navegador (`web/src/oidc.ts`); o `id_token` vai como `Bearer` e o control plane valida (assinatura, issuer, audience, expiração; testado com um IdP falso). A UI lê `GET /api/v1/auth/config` (público: modo, issuer, client_id) em tempo de execução, sem rebuild por ambiente. O e-mail vem de `email`, `preferred_username` ou `upn` (Entra ID costuma omitir `email`). Token JWT expirado guardado é descartado ao abrir. O redirect URI a registrar no IdP é a origem da UI (`https://host/`). Sem refresh token: ao expirar o `id_token`, a pessoa entra de novo. |
| 2026-10-01 | Proxy de LLM para o runner (`POST /runner/v1/llm/chat/completions`): corpo e resposta no formato OpenAI, mas o runner usa `fetch` direto (não o SDK `openai`, para não somar dependência; o formato é compatível). Exige `X-QA-Run-Id` de um run `running` do próprio runner; `X-QA-Task` só `explore`, `plan` ou `judge_result`; o modelo vem do roteamento por tarefa, nunca do runner; limites de 20 mensagens e 100 mil caracteres. O uso entra em `llm_usage` com o `run_id`. |
| 2026-10-01 | Exploração guiada por LLM: o `Planner` só ordena/filtra os candidatos que o explorador já validou (escopo e política destrutiva) e que são enviados como rótulo + rota, sem host, texto da página ou credenciais; índices inválidos são ignorados, então prompt injection não adiciona alvos. Limite `max_llm_calls` no orçamento do run (padrão 30, máx. 200); estourado, falha ou 503 (sem LLM) voltam à ordem natural. O E2E usa respostas gravadas (`runner/e2e/fixtures/llm-replies.json`, escritas à mão). |
| 2026-10-01 | Evidência no object storage (S3/MinIO via `minio-go`; Azure Blob continua previsto atrás da mesma interface `storage.Store`). O runner pede `POST /runner/v1/jobs/{id}/artifacts` e recebe uma URL pré-assinada de PUT limitada a `<org>/<run>/<id>.<ext>`, com tipos permitidos por tipo de evidência (screenshot: png/jpeg etc.). Ao fechar o passo (`step_finished`), o servidor confere que a chave é do run, que o objeto existe e mede o tamanho no storage (máx. 20 MB; maior que isso é apagado e rejeitado). A UI baixa a evidência por `GET /artifacts/{id}/content` (autenticado, com `nosniff` e CSP `sandbox`), nunca por URL pública. `STORAGE_RUNNER_ENDPOINT` permite que os runners usem outro host que o control plane. |
| 2026-10-01 | Passos e histórico por nó: eventos `step_started`/`step_finished` casam por `key` (em qualquer ordem, idempotentes), entradas passam por máscara de segredos (chaves como senha/token/cookie viram `***`) e só podem apontar nós do grafo do run. `GET /nodes/{id}/history` lista os passos do nó ao longo dos runs; `GET /runs/{id}/steps` os de um run. |
| 2026-10-01 | Run de regressão (`type=regression`): reusa o último grafo do ambiente (não cria versão) e testa os nós **cobertos** (com `requirement_link`); sem grafo ou sem nó coberto responde 409. O runner revisita cada nó (URL sem query/hash guardada no metadata na exploração) e confere HTTP < 400 e o mesmo fingerprint (estrutura); falha de teste não falha o run (`succeeded` com `failed > 0` no resumo). O julgamento é determinístico por enquanto; `judge_result` por LLM fica para depois. |
| 2026-10-01 | Bugs: nascem de passos de regressão que falham (`fail` ou `error`); `fingerprint = hash(fingerprint do nó + chave do requisito mais crítico ligado ao nó + assinatura normalizada do erro)`, onde a normalização remove ids, hashes e números mas preserva o código HTTP (500 e 404 são bugs diferentes). Falha repetida = nova ocorrência no mesmo bug; falha de bug `fixed` o reabre (`reopened`); um passo `pass` marca como `fixed` os bugs abertos do nó que não ocorreram naquele run; `false_positive` não muda sozinho e `skipped` não altera nada. Severidade = criticidade do requisito. Mudanças manuais de status seguem a tabela `CanTransition` (409 se inválida), são auditadas (`bug.status`) e `false_positive` exige motivo e vira `knowledge_entry`. Bugs vindos só de erros da exploração (sem requisito) ficam para depois. |
| 2026-10-01 | `POST /bugs/{id}/reproduce` cria uma regressão restrita (`runs.target_node_ids`) ao nó do bug, reencontrado no último grafo do ambiente pelo fingerprint; 409 se o nó não existe mais ou deixou de estar coberto. `GET /runs/{id}/report` traz passos por resultado, resultado por requisito (pior caso por requisito), bugs novos/recorrentes/corrigidos, duração e custo de LLM. |
| 2026-10-01 | Gatilhos: manual (UI/API), agendado e CI passam todos por `run.Create` (um só lugar aplica produção bloqueada, nova versão de grafo na exploração e o requisito de nós cobertos na regressão); o gatilho e o ator ficam no run e na auditoria (`token:<nome>`, `scheduler`). O lock por ambiente continua no banco (índice único parcial). |
| 2026-10-01 | Agendamento sem River: um laço leve no próprio servidor (a cada 30 s) pega schedules vencidos com `FOR UPDATE SKIP LOCKED` (várias instâncias não disparam em dobro), cria o run e avança `next_run_at` com `robfig/cron`. Todo schedule avança mesmo quando é pulado (produção, nada a testar, run do mesmo tipo já ativo) e uma queda longa não gera rajada de recuperação; intervalo mínimo de 5 min; reativar não dispara slots perdidos. River entra só se surgir necessidade de fila de jobs genérica. |
| 2026-10-01 | CI: tokens de projeto (`qat_...`, só o hash no banco, mostrados uma vez, escopos `run:create` e `run:read`, revogáveis, auditados) autenticam apenas `/ci/v1/*` e vice-versa (token de projeto não vale na API de usuário). `qactl run --env NOME --type exploration|regression [--wait] [--junit ARQ] [--timeout 30m]` lê servidor e token só do ambiente (`QACTL_SERVER`, `QACTL_TOKEN`). Saída: 0 ok; 1 requisito `critical` falhou/deu erro ou o run falhou/foi cancelado; 2 uso, autenticação ou recusa do servidor; 3 timeout do `--wait`. JUnit: um caso por requisito (ou um caso do run, se não houver requisitos). O binário `qactl` vai na imagem do control plane. `PUBLIC_URL` (opcional) monta o link do run. |
| 2026-10-01 | Robustez com modelos pequenos ou locais: em modo JSON o gateway devolve só o objeto da resposta (`extractJSON` remove cercas de markdown e frases em volta), e extração de requisitos e cruzamento usam `llm.CompleteParsed`: se a resposta vier inválida, o modelo recebe o erro e é perguntado **uma** vez mais; a 2ª resposta inválida falha com `ErrInvalidOutput` (502 "returned invalid output"). A validação continua estrita (campos desconhecidos, chaves e nós inexistentes, faixa de confiança), então a regra "saída inválida é rejeitada inteira" não mudou; erro do provedor não é repetido. Os prompts pedem explicitamente JSON sem markdown. O limite de uma chamada ao provedor é `LLM_TIMEOUT_SECONDS`. |
| 2026-10-01 | Revisão geral de UX da web (para apresentação): a UI deixou de ser uma tela só e virou páginas por rota de hash (`#/`, `#/mapa`, `#/specs`, `#/bugs`, `#/execucoes`, `#/config/<seção>`), cada uma com link próprio: **Visão geral** (indicadores de cobertura, bugs, última execução e pendências, execuções recentes, requisitos críticos e um guia de "Primeiros passos" enquanto o projeto não está configurado), **Mapa** (o grafo ao vivo e os painéis), **Especificações** (versões, requisitos com busca, filtro por criticidade e cobertura, botão "Nova especificação"), **Bugs** (filtros), **Execuções** (histórico e detalhe, com cancelar) e **Configurações** em abas (projetos, ambientes, credenciais, tokens de CI, agendamentos com frequências em português, aparência). Tema claro/escuro/automático pela escolha da pessoa: `data-theme` no `<html>`, definido por um script no `index.html` antes da primeira pintura (sem flash), preferência em `localStorage` (`qa_theme`). Feedback por avisos (toasts) em vez de silêncio, inclusive para tarefas longas ("Cruzando requisitos…"). A nova spec abre num diálogo com arrastar-e-soltar de arquivo e etapas visíveis (enviada → extraindo com IA, com relógio → salva, seguido da lista de requisitos extraídos e do atalho "Cruzar com o mapa"); como a ingestão é uma chamada síncrona, a etapa de extração é indeterminada (barra animada e tempo decorrido), sem simular uma porcentagem que o servidor não informa. Textos de status em português (crítico/alto, novo/confirmado, passou/falhou). |
| 2026-10-01 | Andamento ao vivo da exploração: o runner envia os eventos a cada 1 s durante o job (`EventSink.startAutoFlush`, lotes em série e na ordem; antes só enviava no fim, então o grafo inteiro aparecia de uma vez) e o run expõe `created_at`/`started_at`/`finished_at`. Na UI, um cartão "Mapeando a aplicação" mostra telas mapeadas contra `max_pages`, ligações, tempo contra `max_seconds` e um feed de descobertas (calculado no cliente pela diferença entre versões do grafo, sem endpoint novo); nós recém-descobertos pulsam e a câmera acompanha o mapa até a pessoa mexer nela. Enquanto há run ativo a UI também consulta o grafo a cada 2,5 s, para o caso de o stream SSE cair ou ser retido por um proxy. |
| 2026-10-01 | Visual da web (pedido do time): referência é o app do Zoom para Mac (sidebar clara com seletor de projeto/ambiente, ações rápidas em "tiles" de cantos bem arredondados, cartões de vidro, botões em pílula, azul `#0b5cff` como cor primária e laranja no destaque), com tema claro, escuro ou automático (escolha da pessoa), só CSS puro com variáveis (sem biblioteca de UI nem de ícones; os ícones são SVGs em `web/src/icons.tsx`). O grafo segue o estilo do Obsidian: nós são esferas com brilho e sombra (cor = cobertura/falha, anel = papel, tamanho = nº de ligações), arestas finas, passar o mouse esmaece tudo menos o nó e seus vizinhos, nós podem ser arrastados e novos nós "surgem" com animação. O layout (`web/src/layout.ts`, próprio, determinístico, sem dependência) é uma árvore radial: o início da exploração no centro, cada nível num anel, cada ramo numa fatia do círculo, com um relaxamento curto para separar o que ficou perto. Só a árvore de descoberta (BFS, como o crawl do runner) é desenhada; as demais ligações (barra de navegação, "voltar") ficam escondidas e aparecem sob demanda ("Todas as ligações") ou em volta do nó sob o mouse, porque num app real toda página liga para todas as outras e o desenho vira um novelo. Com o grafo crescendo, os nós já posicionados (inclusive os arrastados) não se mexem e os novos nascem ao lado do pai; ao fim da exploração, ou em "Reorganizar", tudo é posicionado de novo. Nomes aparecem conforme o zoom (só as telas principais quando afastado). Painéis de bugs, pendências, relatório e detalhes do nó ficam numa coluna flutuante sobre o canvas; a configuração abre como folha lateral. O mini-mapa foi removido. |
| 2026-10-02 | Exploração interativa (pedido: "tudo de fato", não só links): em cada tela o runner faz o inventário do DOM (`data-qa-ref` em formulários, campos e botões), **entende** a tela (heurística; com LLM, só rótulos/papéis/tipos, nunca valores nem texto da página, e a saída é validada) e testa o que é seguro, recarregando a página a cada ação e abrindo modais por clique (um nível). O que aprende vai para o nó (`metadata`: `summary`, `forms`, `controls`, `actions`, mensagens e diálogos) e para o grafo: **cada endpoint por método** (`GET /x` e `PATCH /x/{id}` são nós diferentes; o verbo efetivo vem do `_method` do Rails), modais viram nós, e o que um envio abriu vira ligação. O cruzamento recebe esse resumo (marcado como dado). Limites: `max_actions` no orçamento (padrão 60, máx. 500) e 14 ações por tela; `max_llm_calls` agora vale para planejador e analista juntos. |
| 2026-10-02 | Regras de segurança da exploração interativa: **nunca** sair da sessão nem remover a conta, em nenhuma política; controles de excluir/enviar para fora só rodam sob `destructive_policy=allow` e por último; sob `block`/`confirm` o contexto do navegador **aborta toda requisição de escrita** (POST/PUT/PATCH/DELETE), que é registrada como `blocked` (aprende endpoint e verbo sem mudar nada) — a trava é de rede, não do prompt; formulários com senha e com arquivo obrigatório nunca são tentados; valores digitados são dados de teste (`Cliente QA 123`) e campos sensíveis são `***` em evidência e eventos. |
| 2026-10-02 | Várias especificações por projeto, cada uma executável sozinha: o run de regressão aceita `spec_id` (gravado no `budget`, validado pelo servidor); o job só leva os nós e as chaves de requisito daquela spec e o relatório só conta os requisitos dela. `PATCH/DELETE /specs/{id}` (renomear, excluir) e `POST /specs/{id}/requirements`, `PATCH/DELETE /requirements/{id}` (criar, editar, excluir; edição pela pessoa não muda a chave). Excluir spec ou requisito apaga ligações e pendências e **desliga** os bugs (ficam, sem requisito). O cruzamento já aceitava `spec_id`. `GetLatestSpec` ignora a spec automática: "a spec do projeto" (cruzamento padrão, diff de nova versão) é a mais nova escrita por pessoas. Tudo auditado (`spec.update`, `spec.delete`, `requirement.*`). |
| 2026-10-02 | Spec automática "Varredura automática" (`source_type=auto`, `internal/autospec`): uma por projeto, gerada **sem LLM** do último mapa do ambiente — um requisito `PAGE /rota` por tela (normal) e `FORM MÉTODO /ação` por formulário (alto se escreve, normal se GET), todos ligados ao nó com confiança 1; formulários com senha e endpoints observados ficam de fora; teto de 400. É recriada ao fim de toda exploração que terminou bem (`runnerapi` complete, melhor esforço: falha só vira log) e sob demanda em `POST /environments/{id}/specs/auto` (201 na primeira vez, 200 depois, 409 sem mapa). Regerar é idempotente e mantém a identidade dos requisitos cujo texto não mudou (resultados e bugs ficam); sumiram do mapa, saem. Consequência: depois de explorar, todo nó de página fica coberto e a regressão sempre tem o que testar. |
| 2026-10-02 | Evidência de cada checagem, passe ou falhe: o passo de página guarda captura **e** um JSON (`http`: URL final, status HTTP, papel, esperado/obtido, estrutura); o passo de formulário (`FORM ...` nas chaves do nó) guarda `inputs` (valor digitado, `***` nos sensíveis), `requests` (verbo, caminho, status, `blocked`, nomes dos campos), mensagens da tela, diálogo, política e resultado, mais a captura. Formulário que o ambiente não deixa enviar é `skipped` (não falha) e mostra o que seria enviado; falha de verdade = não enviou/HTTP ≥ 400/validação. A UI mostra tudo em Execuções ("Checagens e evidências") e no histórico do nó (`EvidenceDetails`), buscando o JSON pela API autenticada. Para de fato inserir dados na regressão o ambiente precisa de `destructive_policy=allow`. |
| 2026-10-04 | Cores do mapa por resultado de teste: `GET /environments/{id}/node-status` devolve, por nó do último grafo, o pior resultado dos passos da **run mais recente que o testou** (página e formulários juntos; `fail > error > pass > skipped`), e o veredito **acompanha a tela entre versões do grafo** pelo fingerprint. O nó traz `requirement_count` (requisitos de qualquer spec, a automática incluída): é isso que o deixa "coberto"; antes a cobertura vinha só da spec escrita à mão e o mapa ficava cinza quando só existia a automática. Cores: passou verde, falhou vermelho, pulado roxo, coberto e não testado azul, pendência laranja, sem spec cinza. |
| 2026-10-04 | Vários usuários: cada credencial do ambiente é um usuário (o nome é o `app_role`) e cada usuário é explorado e testado à parte; os nós já são por usuário (o fingerprint inclui o papel). A regressão aceita `budget.roles` (validado contra as credenciais do ambiente, no máximo 20; vale para regressão e, desde 2026-10-05, para exploração, que então copia para o novo mapa o que já existia dos outros usuários) e a run guarda a lista. O usuário de cada passo é o do nó (`user` nos passos, `users` e `by_user` no relatório; `summary.by_role` na exploração e na regressão). A UI mostra "Testado como", tabela por usuário, "como X" em cada checagem, resultado por usuário em cada requisito, filtro "Ver como" e a visão "Acesso por usuário" no mapa (quem alcança o quê; telas que só alguns alcançam vêm primeiro). Limites de orçamento subiram para apps grandes: 2000 telas, profundidade 15, 4 h, 2000 ações. |
| 2026-10-04 | O orçamento de ações e o registro de endpoints e janelas são **por usuário** (`newInteractiveState` por credencial; a semente dos dados de teste parte de `índice*1000`): compartilhados, o 2º usuário herdava a sobra e não registrava os endpoints que o 1º já viu, o que fabricava diferenças entre usuários. O planejador de IA **só reordena**: o que uma ação já levou (envio, busca, clique) é sempre seguido (`mustFollow`), senão a IA descartava a busca de um usuário e não a do outro. |
| 2026-10-04 | Mapeamento mais assertivo: o navegador espera a tela **estabilizar** antes de ler (requisições de script/dados em andamento via rastreio de `request`/`requestfinished`, DOM quieto, rolagem de páginas longas, e até 1,5 s por conteúdo vazio de SPA quando a página tem scripts); custa cerca de 0,35 s por visita em página estática. Ações que revelam links sem navegar (menu, aba, sanfona) devolvem `links`, e o explorador os segue. Tela que responde 200 mas mostra erro ("Something went wrong") é detectada (`detectSoftError`: conteúdo curto no `<main>`, sem campo de entrada, frase de erro) e vira `soft_error` no nó e no resumo; na regressão falha. A regressão tenta de novo **uma vez** o que pode ser instabilidade (5xx, exceção, tela de erro, estrutura mudada; 4xx não); passar na 2ª é `pass` com "passou na 2ª tentativa" e `flaky` na evidência. |
| 2026-10-04 | Módulo **Fluxos** (`#/fluxos`, o mapa ficou como estava): fluxograma da esquerda para a direita, **uma raia por usuário**, uma caixa por tela com a miniatura, o usuário e a cor do último teste; a mesma tela para dois usuários são duas caixas lado a lado, e a tela que um usuário não alcança é um **fantasma "sem acesso"** na raia dele. Diferenças de permissão vêm dos controles e formulários lidos na exploração (`screenDifferences`: "só admin tem: Excluir"). Origens: **Jornadas** (o que a exploração achou: abrir janela, enviar, buscar, chamar endpoint, sem os links de menu), **Requisitos** (telas ligadas a cada requisito de uma spec) e **Execução** (o que uma regressão testou, com o resultado daquela run). Tudo calculado no cliente (`flows.ts`, funções puras testadas). Colunas com no máximo 4 telas (as demais quebram em sub-colunas), endpoints em caixas compactas, setas dentro da raia do usuário e voltas ("Início") omitidas; a caixa e o painel de detalhes mostram o nó que **falhou** quando a rota tem mais de um. |
| 2026-10-04 | Miniaturas: a exploração tira um JPEG (qualidade 55, **campos de entrada cobertos** com `mask`) de cada tela nova de cada usuário, antes de qualquer ação, e manda o evento `node_thumbnail` depois do nó. O servidor confere como toda evidência (chave da run, objeto existente, até 20 MB, só imagem) e guarda a chave em `nodes.thumbnail_key`; a UI busca `GET /nodes/{id}/thumbnail` (autenticado, `nosniff`, CSP `sandbox`) com cache e `onlyRenderVisibleElements`. Falha ao tirar ou guardar a imagem nunca custa uma tela do mapa. As imagens podem mostrar dado de cliente na tela (só os campos de entrada são cobertos): entra na política de retenção da seção 18. |
| 2026-10-05 | Bugs deduplicados **entre usuários**: o fingerprint é `hash(rota + chave do requisito + assinatura do erro)` (`RouteFingerprint`), não do nó (que é por usuário), então a mesma rota falhando do mesmo jeito para admin e operador é um bug com duas ocorrências e `users` (quem ele afeta). O requisito do bug vem de **qualquer nó da mesma rota**; a nota do retry ("falhou nas 2 tentativas") não entra na assinatura nem no título, e o título cita a rota uma vez só (chave de requisito gerada, como `PAGE /x`, não repete). Bugs gravados antes são achados pelo fingerprint antigo e movidos para o novo (sem perder histórico). Limite conhecido: um bug só vira `fixed` quando passa o nó que o originou. |
| 2026-10-05 | A **spec automática é por ambiente** (`specs.environment_id`, título "Varredura automática · ambiente"): cada ambiente tem o seu mapa, e explorar um não reescreve a spec do outro (antes era uma por projeto). A migração liga as já existentes ao ambiente das telas a que seus requisitos estão ligados. O texto do requisito de tela é conciso (título, ações vistas, usuários e, quando só alguns usuários alcançam, "Só alcançada por: …"; o resumo mecânico "Tela /x — …" é omitido) e há `VALIDATE POST /x` para formulário de escrita com campo obrigatório visível (não vale GET, DELETE, senha nem arquivo): o runner envia vazio e passa se a tela recusa e diz o que falta, ou o servidor recusa (4xx) ou devolve o formulário com mensagens; falha se aceita; `skipped` se o ambiente bloqueou a escrita. Teto de 1.500 requisitos. |
| 2026-10-05 | Qualidade e escala das specs: o extrator por IA tem um prompt com regras de requisito bom (um comportamento, critério de aceite no texto, sem palavra vaga, régua de criticidade) e lê specs longas **em partes** (6.000 caracteres, cortadas em linhas em branco e antes de títulos); cada parte recebe as chaves já usadas, chaves repetidas ganham a próxima livre e o que já foi dito (mesmas palavras) é descartado; parte inválida duas vezes falha tudo. Requisitos escritos ou extraídos (`REQ-N`) levam `quality` na API (`vago`, `curto`, `composto`, `parecido com REQ-X`), mostrado como "revisar" na UI. O cruzamento spec × mapa roda em **lotes** (25 requisitos por chamada; em mapa com mais de 100 telas, as 80 mais relacionadas por palavras raras de cada lote, incluindo o que a exploração aprendeu da tela; antes só os 300 primeiros nós iam ao modelo); máximo 60 lotes. |
| 2026-10-05 | Escala da execução: passos de uma run são paginados e filtrados no servidor (`GET /runs/{id}/steps?result=&user=&limit=&offset=`, problemas primeiro, total em `X-Total-Count`) e o módulo de Fluxos usa `GET /runs/{id}/node-results` (pior resultado por nó). A regressão aceita `budget.concurrency` (1 a 6 navegadores por usuário, cada um entra por conta própria; padrão 1 porque alguns sistemas encerram a primeira sessão num novo login). |
| 2026-10-05 | **Relatório geral** exportável de qualquer página (botão "Relatório"): `GET /environments/{id}/brief` calcula os **fatos** a partir do que a plataforma sabe (mapa, usuários, cobertura de requisitos e telas, telas só de alguns usuários, jornadas, última regressão com requisitos que falharam por usuário, bugs, pendências, prontidão da ferramenta) e as **inconsistências entre fluxos e especificações** (requisito sem tela, tela sem requisito, jornada sem requisito, qualidade, fluxos alternativos, regressão sobre mapa antigo, bugs críticos), por gravidade, mais um texto **padrão** (template, sempre disponível). `POST …/brief/narrative` pede à IA (tarefa `summarize`) para reescrever o template **no mesmo formato fixo** (7 seções com ids e títulos nossos); a resposta é rejeitada se faltar ou sobrar seção, passar dos limites ou citar número maior que 10 que não esteja nos fatos (uma nova tentativa leva o erro ao modelo). A UI baixa HTML (para imprimir ou salvar em PDF), Markdown ou JSON, tudo no navegador, com escape de qualquer texto vindo da aplicação testada. A Visão geral mostra os pontos de atenção e o que falta preparar (runner, IA, armazenamento, usuários, mapa, spec, regressão) a partir dos mesmos fatos. |
| 2026-10-05 | **Exploração só de alguns usuários** (`budget.roles` numa exploração, validado contra as credenciais do ambiente): o runner entra só com eles, a exploração cria a nova versão do grafo e **copia para ela o que foi mapeado dos outros usuários** (telas com miniaturas, ligações entre elas e os requisitos ligados a essas telas; os endpoints já eram carregados por toda exploração). Antes, mapear um usuário apagava o mapa dos outros. Sem usuários escolhidos continua sendo um mapa limpo e completo. A run guarda a lista ("Explorado como"). |
| 2026-10-05 | **Continuar uma exploração interrompida** (`budget.resume`): a nova run trabalha **no mesmo grafo** da última exploração (nada do que já foi achado se perde), desde que ela tenha parado antes do fim (cancelada, falhou, ou terminou por limite de telas ou de tempo; uma que esgotou o mapa dá 409). O job leva `resume.known` (as telas já examinadas de cada usuário, pela impressão digital, e para onde as ações nelas levaram, guardado no nó em `metadata.followed`, até 10 por tela) e `resume.generation` (quantas explorações vieram antes, para os dados de teste não repetirem). O runner **revisita** as páginas (é só leitura, ~0,35 s cada) para achar a fronteira do que faltou, mas não examina, não anuncia nem fotografa de novo as conhecidas, e só as telas **novas** contam no limite de telas; as ações que levaram a lugares são seguidas a partir do que ficou guardado. Pode ser combinada com a escolha de usuários. Limite: a fronteira de telas alcançadas só por uma ação de uma tela que ainda não tinha sido examinada quando parou se perde (o que ela mostrava de link se acha de novo). |
| 2026-10-05 | **Verificações de segurança dentro da exploração e da regressão** (sem módulo próprio; ligadas por padrão, `budget.no_security` desliga; caixa "Verificar segurança" nos dois diálogos). **Passivas**, em cada página já visitada: cabeçalhos (CSP, clickjacking, nosniff, HSTS, versão do servidor), cookies pelo `Set-Cookie` cru (HttpOnly e SameSite do cookie de sessão, Secure em HTTPS), formulário que altera dados sem token anti-CSRF e sem sessão SameSite Lax/Strict (formulários de senha e de busca não entram), senha enviada sem HTTPS, conteúdo misto, e o que a página diz (stack trace/modo debug, erro de banco, listagem de diretório; vale até em página 500). **Ativas, só leituras** (seguras sob qualquer política): nos parâmetros do endereço da página e em formulários GET de texto (até 150 endereços por usuário, por rota+parâmetros), um valor com aspas e uma marca `<qaxssN>` — a marca virar **elemento da página** prova XSS refletido (sem rodar script), mensagem de erro de banco que não aparece com valor comum é SQL injection (`critical`), 500 só com o valor especial é suspeita (`normal`); parâmetros de redirecionamento (`next`, `url`, `redirect`...) recebem um endereço que nunca resolve e a resposta é lida **sem seguir** o redirecionamento; uma vez por run: arquivos que não podem ser servidos (`.git/HEAD`, `.env`, `phpinfo`, `server-status`, `actuator/env`, `web.xml`, reconhecidos pelo conteúdo, não pelo status) e CORS que aceita qualquer origem com credenciais. Em ambiente local/rede privada (`localhost`, `host.docker.internal`, `10.*`, `192.168.*`...) o HTTP simples é esperado e as checagens de transporte (HSTS, Secure, HTTPS, conteúdo misto) não rodam. A regressão refaz as injeções nas telas que testa a partir do que a exploração guardou no nó (`metadata.query`, só os **nomes** dos parâmetros, e formulários GET); o servidor monta `targets[].probes`. **Não faz**: POST com payload (XSS armazenado, SQL injection por formulário), controle de acesso (IDOR), SSRF, upload, autenticação, TLS, dependências: continua sendo pentest. |
| 2026-10-05 | **Achados de segurança são passos e bugs de categoria própria**: cada (check, escopo, usuário) vira um passo `SEC <check> <escopo> @<usuário>` com `run_steps.security` (`check`, `severity`, `scope`) e a tela onde foi visto (`node_fingerprint` na exploração, `node_id` na regressão); falha de um check = `fail`, check que rodou limpo = `pass` (para ver que foi corrigido). O bug tem `category=security`, `severity` dada pelo check (não pela criticidade do requisito da tela), título `Segurança · <frase>` e impressão digital `hash(check + escopo)`, **sem usuário nem tela** (o mesmo cabeçalho ausente no admin e no operador é um bug que "afeta" os dois); o escopo é a rota e o parâmetro para injeções e o nome do cookie/formulário quando há (`xss-reflected` em `/search?q`). **Só o passe do mesmo check e escopo corrige o bug**; um passe funcional da tela não mexe nele, e uma falha de segurança nunca vira falha do requisito, nem pinta o nó no mapa nem entra nas contagens dos passos do run (as consultas de resultado e de nós filtram `security IS NULL`). `GET /runs/{id}/steps` abre nos passos funcionais (`?kind=security` ou `all`), o relatório da run traz `security` (verificações, aprovadas, falhas por gravidade) e `GET /projects/{id}/bugs?category=`. Os resumos das runs guardam `security` (verificações, falhas, endereços tentados). |
| 2026-10-05 | O **relatório geral** ganhou a seção fixa **Segurança** (agora oito: escopo, cobertura, fluxos, usuários, resultados, riscos, segurança, próximos passos; a IA tem de devolver as oito) e `facts.security` (`checked`, números da última run que fez as verificações, falhas abertas por gravidade e a lista); os bugs de segurança saem de "Riscos e bugs" e de `facts.bugs`. Pontos de atenção novos: `security_critical` (alta), `security_high` (média) e `security_unchecked` (baixa, quando nenhuma run fez as verificações). A Visão geral tem o cartão "Segurança" e a página de Bugs o filtro por tipo e a marca "Segurança". |
| 2026-10-05 | **Login robusto** (`executors/browser/login.ts` + `loginpage.ts`): o runner entra como uma pessoa entraria, em apps que ninguém descreveu. Acha a tela de login na página, atrás de um link ou botão "Entrar/Login/Sign in/Acessar" (ignora "Criar conta", "Esqueci a senha"), ou, se nada leva a ela, nos endereços comuns (`/login`, `/signin`, `/users/sign_in`, `/entrar`...); espera a tela que um script desenha tarde; acha o campo do usuário pelo que ele diz ser (autocomplete, nome, rótulo, tipo e-mail; nunca uma busca) e a senha do formulário que tem uma só; trata o **primeiro passo que só pede o usuário** ("Próximo") e envia por Enter **e** pelo botão quando Enter não faz nada. Sucesso é o campo de senha ter sumido **e** a resposta da navegação não ter sido 4xx/5xx (um 401 sem formulário é recusa). **Se há credencial e não há tela de login, o login falha** (`no_form`): antes o runner "passava" e mapeava só a área pública. Cada falha tem motivo e texto para a pessoa: `rejected` (com o que a tela disse), `no_form`, `needs_more` (captcha ou código 2FA, que o agente não resolve), `sso_blocked` (o login passa por um site fora dos hosts permitidos, que é nomeado), `unreachable`, `error`. |
| 2026-10-05 | **Run bloqueada = um problema, não bugs**: se a aplicação está fora do ar (nada responde, ou 502/503/504 do proxy **e** o runner também não a alcança, em duas tentativas) ou o login não funciona, a run **não registra passo nenhum** e escreve `summary.blocked` (`kind` `app_down` ou `login_failed`, `message` com o que fazer, `roles`, `details` por usuário). Só se pergunta à aplicação depois de uma falha suspeita (erro de rede ao abrir página ou 502-504), nunca numa run saudável. Um erro de rede isolado com a aplicação respondendo continua sendo o erro daquela tela. Sem usuário que entre ou sem aplicação, a run termina **`failed`** com `error`; se outros usuários foram mapeados, termina `succeeded` com `blocked` avisando de quem não entrou. As telas de um usuário que não entrou ficam em `not_tested` (não são falha, não viram bug). No servidor, uma exploração bloqueada **sem nenhuma tela** descarta o grafo vazio que criou (o mapa anterior continua sendo o mais novo; a run fica sem grafo) e uma que mapeou só alguns usuários **copia o mapa anterior de quem não entrou** (não aprendeu nada novo sobre eles); uma continuação nunca abre mão do grafo. O relatório geral ganhou `facts.blocked` (a última run que terminou, de qualquer tipo), o ponto de atenção `environment_blocked` (alta, o primeiro, no lugar de `login_failed`), a checagem de prontidão "Aplicação no ar e login funcionando" e a primeira recomendação. A UI tem **um aviso só**, em todas as páginas ("A aplicação está fora do ar" / "O login não funcionou", com "Abrir credenciais" e "Ver a execução"), que some quando uma run seguinte funciona; a run aparece como **Bloqueada**, não "Falhou", com a tabela "Usuários que não entraram". |
| 2026-10-07 | **Autenticações complexas, de forma genérica** (`docs/autenticacao.md`): o princípio é que a única via agnóstica de provedor para passar por qualquer login (SSO, 2FA, captcha, magic link, passkey, IdP corporativo) é **não executar o login** e sim **reusar uma sessão já autenticada**. Duas camadas novas, escolhidas pelo `kind` da credencial: **(1) reuso de sessão** (`kind=session`): guarda, por usuário, um `storageState` do Playwright (cookies + storage), cifrado como as demais credenciais; o runner carrega em `newContext({ storageState })` e **não** faz login. A captura é `npm run capture` (no pacote `runner`, Playwright) — abre um navegador visível **sem trava de host** (o login passa pelo IdP), a pessoa entra uma vez, e o estado é enviado por `PUT /ci/v1/credentials/session` (escopo novo `credential:write`; opção "Permitir salvar sessões capturadas" no token de CI da UI). Sessão expirada é detectada ao abrir a URL base (parede de login: formulário, primeiro passo, ou link "Entrar") e vira run **bloqueada** `session_expired` pedindo recaptura (reusa o mecanismo de run bloqueada; Go não dirige Playwright, por isso a captura vive no runner e não no `qactl`). **(2) semente TOTP** (`kind=login` + chave opcional `totp_secret` em base32): quando a tela pede o código depois da senha, o runner calcula o código RFC 6238 (SHA-1, 30s, `runner/src/executors/browser/totp.ts`, sem dependência nova) e preenche; sem `totp_secret`, continua o aviso `needs_more` ("2FA que o agente não resolve"). O login heurístico de usuário/senha segue como padrão. Segredos (a sessão inclusa) cifrados em repouso, nunca devolvidos, entregues só no lease; trava de host, bloqueio de produção e política destrutiva inalterados. **Ficou para depois**: captura 100% pela web (navegador remoto transmitido), receita de login gravada (`kind=steps`), OIDC/OAuth programático (ROPC), refresh automático de sessão, e 2FA por SMS/e-mail/push e captcha (delegados ao reuso de sessão). |
| 2026-10-07 | **Credencial de login só com usuário, e editar/excluir credenciais** (pedido de quem testou um app Azure AD B2C): a validação de `kind=login` passa a exigir só `username` (a senha é opcional), para SSO/magic-link e fluxos de primeira etapa que só pedem o e-mail; a UI de Credenciais deixou o campo de senha opcional (com dica) e ganhou **Editar** (reaproveita o upsert por `app_role`) e **Excluir** (`DELETE /api/v1/credentials/{id}`, só escritor, auditado `credential.delete`). A dica de SSO do runner deixou de só mandar "adicione o host": agora recomenda **capturar uma sessão** (`kind=session`, `npm run capture`), que funciona com qualquer SSO/2FA/captcha, e cita adicionar o host dos IdPs só para provedores simples de usuário e senha — porque adicionar o host de um B2C com MFA não deixa o agente entrar sozinho. |
| 2026-10-07 | **Captura de sessão pela interface — navegador remoto** (`internal/capture`, `web/src/CaptureDialog.tsx`, `runner/src/capture/`): a captura de `storageState` (para `kind=session`) deixou de exigir a CLI. Em Configurações → Credenciais, "Capturar sessão (SSO/2FA)" abre um navegador **no runner** cuja tela é transmitida ao diálogo como quadros JPEG; a pessoa loga ali (SSO/2FA/captcha) e, em "Concluir login", o runner entrega o `storageState`, que o control plane cifra como credencial `session`. Captura "pura no navegador" da UI é **impossível** (Same-Origin Policy + cookie de sessão HttpOnly), por isso o navegador vive no runner. Transporte **sem dependência nova**, reaproveitando os padrões existentes: quadros por **SSE** (`GET /api/v1/capture/{id}/stream`, fetch com header, como o grafo), input (clique/tecla, coordenadas normalizadas 0..1) por **HTTP** em lote (`POST /api/v1/capture/{id}/input`); o runner, num **segundo laço** independente do de jobs, faz `POST /runner/v1/capture/lease` (long-poll), manda screenshots (`.../frame`), aplica o input via Playwright (`page.mouse`/`keyboard`) e devolve o estado (`.../result`). O **estado vivo fica em memória** no control plane (`capture.Hub`, escopado por organização, sessão expira em 10 min); só a credencial `session` é persistida e cifrada — nada de tabela nova. O navegador da captura **não** tem trava de host (o login passa pelo IdP). **Ficou para depois**: captura remota multi-instância (hoje é instância única, como o compose; SaaS exigiria afinidade/transporte compartilhado), receita de login gravada (`kind=steps`), OIDC programático, refresh automático de sessão. |
| 2026-10-07 | **Classificação de login SSO ficou mais precisa e a captura ganhou watchdog de status**: `sso_blocked` agora considera só bloqueios fora de `allowed_hosts` que sejam relevantes ao fluxo de autenticação (navegação `document`/`isNavigationRequest` ou chamadas `xhr/fetch`), para não confundir bloqueio de assets de terceiros (ex.: `fonts.googleapis.com`, `googletagmanager.com`) com IdP real. No diálogo de captura (`web/src/CaptureDialog.tsx`), a UI passou a consultar `GET /api/v1/capture/{id}` periodicamente e mostrar mensagens de espera progressivas quando não chegam quadros, evitando o estado aparente de "carregando runner para sempre" sem feedback. |
| 2026-10-08 | **Captura não fica mais presa por sessão antiga**: ao criar uma nova captura, o `capture.Hub` cancela qualquer sessão aberta (`pending`/`active`) da mesma organização, para que tentativa nova não fique atrás de uma sessão zumbi. No diálogo (`web/src/CaptureDialog.tsx`), se não houver quadro por 90 s a sessão é cancelada automaticamente e a pessoa recebe mensagem clara; se o stream cair sem evento final, a UI encerra e cancela para não bloquear a próxima tentativa. |
| 2026-10-07 | **Proteção da conta usada nos testes**: formulários que parecem alterar o próprio usuário autenticado (perfil, conta, e-mail/senha/2FA) são sempre pulados pelo runner, independentemente da política destrutiva (`allow` inclusive), tanto na exploração interativa (`runner/src/agent/probe.ts`) quanto nos checks de formulário da regressão (`runner/src/agent/formcheck.ts`). A heurística (`isOwnAccountForm`, em `runner/src/agent/controls.ts`) combina rota/label/campos fortes de credencial para evitar que uma run invalide o login da próxima. |
| 2026-10-07 | **Componentes reutilizáveis (header/sidebar) mapeados uma vez** (pedido de quem viu o mapa duplicar): a exploração reconhece o "chrome" da aplicação — elementos dentro de `header`, `nav`, `aside`, `[role=banner/navigation/complementary/menubar]` ou num contêiner `position: fixed`/`sticky` — e marca botões, formulários e links com `chrome` (`inventory.ts` e o `visit` do `driver.ts`, ambos no `page.evaluate`). **Ações** de chrome (ex.: o botão "Trocar de organização" do header) são executadas **uma vez por usuário** e puladas nas telas seguintes (`probe.ts` guarda a assinatura `tipo|intenção|rótulo` num `chromeSeen` da `InteractiveState`; o resumo ganha `skipped_chrome`). **Links** de chrome (a sidebar) só viram aresta na **primeira** tela em que aparecem (`chromeLinkSeen` por padrão de rota no BFS do `explorer.ts`), em vez de uma aresta de cada página para cada item do menu. Antes, `contratos → trocar de organização` e `manutenção → trocar de organização` eram mapeados de toda tela; agora a descoberta continua completa (a sidebar enumera os destinos a partir da home), sem o novelo. Heurística: landmarks semânticos + `fixed/sticky`; sob jsdom (testes) vale só o landmark, pois não há layout. |
| 2026-10-09 | **Fluxos guiados por possibilidades da tela (fatia 1 do redesenho)**: o módulo de Fluxos passou a derivar e exibir, em cada tela/usuário, as possibilidades observadas (`forms`, `controls`, `followed` + transições), com overlay de resultado (`pass`/`fail`/`skipped`/`untested`). Jornadas voltaram a incluir navegação (`link`) para refletir o que a tela oferece, e chamadas de endpoint (`request`) saíram da raia principal (ficam como detalhe da tela), reduzindo o efeito de "despejar resposta na rota". Implementado em `web/src/flows.ts`, `web/src/FlowChart.tsx`, `web/src/ScreenCard.tsx`, `web/src/pages/FlowsPage.tsx` e estilos em `web/src/pages.css`; validado por testes em `web/src/flows.test.ts` e `web/src/ScreenCard.test.tsx`. |
| 2026-10-09 | **Especificações separadas em negócio vs técnico (fatia 2 do redesenho)**: os requisitos passaram a expor `category` derivada (`business`/`technical`) no payload de `GET /api/v1/specs/{id}/requirements` (`control-plane/internal/spec/manage.go`, `control-plane/internal/spec/http.go`), sem migração de banco; regra: `source_type` `auto`/`openapi` é técnico, e em specs de texto `REQ-*` é negócio. Na UI de Especificações (`web/src/pages/SpecsPage.tsx`), a tabela agora filtra por tipo em abas "Requisitos" e "Verificações automáticas", mantendo criticidade/busca e mostrando flags de qualidade só no tipo de negócio. Validado em `web/src/pages.test.tsx`; em `control-plane/internal/spec/manage_test.go` foram adicionadas asserções de categoria. |
| 2026-10-09 | **Capacidades de produto por ambiente (fatia 3 do redesenho)**: foi criado `GET/POST /api/v1/environments/{id}/capabilities` (`control-plane/internal/capability/http.go`, registrado em `cmd/server/main.go`) para agrupar telas do último mapa em capacidades determinísticas por domínio de rota (primeiro segmento), com agregados (`nodes_total`, `nodes_covered`, `nodes_tested`, `status`) e status por tela a partir do último resultado funcional. A UI ganhou a página **Produto** (`#/produto`) com navegação própria e ação de recálculo (`web/src/pages/ProductPage.tsx`, `web/src/App.tsx`, tipos em `web/src/api.ts`). Validação: `npx vitest run src/route.test.tsx src/pages.test.tsx` no `web` e `go test ./internal/capability -run TestCapabilities -count=1` em container Linux. |
| 2026-10-09 | **Mapa e relatório capability-cêntricos (fatia 4 do redesenho)**: o relatório geral (`internal/brief`) passou a agregar cobertura por capacidade (agrupamento determinístico por domínio de rota, com total/cobertas/testadas/com falha e status por capacidade), incluindo isso nos fatos e no texto padrão (`facts.go`, `http.go`, `narrative.go`). A exportação (`web/src/briefReport.ts`) agora mostra capacidades no Markdown/HTML, e a Visão geral ganhou o cartão **Capacidades** consumindo `GET /environments/{id}/capabilities`. A navegação explicitou o drill-down técnico (`Mapa técnico`) e a página Produto ganhou atalho para ele. Validação: `go test ./internal/brief -count=1` em container Linux e `npx vitest run src/pages.test.tsx src/briefReport.test.ts src/route.test.tsx` no `web`. |
| 2026-10-05 | Usabilidade (revisão para a POC): a cobertura da Visão geral usa a spec escrita ou, se não há, a automática do ambiente; especificações de outros ambientes ficam fora da lista; o mapa guarda a barra de visão embaixo (não sobrepõe a legenda) e mostra só 3 bugs com atalho; a Run de regressão não mostra mais a tabela "usuários explorados" (o resumo de regressão tem outra forma sob o mesmo nome); em Fluxos cada tela diz por quais requisitos é coberta ou "sem requisito", o fluxo avisa quantas telas não têm requisito e há filtro para isso. |

---

## 14. Hurdles (armadilhas descobertas)

_Vazio. Registre aqui cada armadilha técnica encontrada, com sintoma, causa e solução.

2026-10-01 · Go não está instalado na máquina de dev (`go: command not found`). Solução: rodar via Docker, ex.: `docker run --rm -v "$PWD":/app -w /app golang:1 go test ./...` dentro de `control-plane/`._
2026-10-01 · Testes com testcontainers dentro do container Go: montar `/var/run/docker.sock` e definir `TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal` e `TESTCONTAINERS_RYUK_DISABLED=true`. Já embutido em `make test` (`control-plane/Makefile`).
2026-10-01 · `vitest` falhou com `Cannot find native binding` (bug de dependências opcionais do npm). Solução: apagar `node_modules` e `package-lock.json` e rodar `npm i` de novo.
2026-10-01 · `govulncheck` acusou `x/crypto` e `moby/go-archive` via testcontainers (só testes). Solução: `go get` das versões corrigidas; o CI falha enquanto houver vulnerabilidade chamada.
2026-10-01 · `gosec` ignora `//nolint`. Evite conversões `int→int32` que o disparam (G115) tipando o dado como `int32` desde a origem.
2026-10-01 · sqlc gera o tipo `Requirement` no pacote `spec`; tipos de domínio escritos à mão não podem ter o mesmo nome de um model (usamos `spec.Item`).
2026-10-01 · macOS (BSD `sed`/`perl`): `sed` não entende `\b` e quebra com `/` na substituição; use `perl -pi -e` ou python para edições em lote.
2026-10-01 · `go test` com vários pacotes subindo Postgres em paralelo derrubou o Docker (exit 137, falta de memória). `make test` agora usa `-p 2`.
2026-10-01 · Teste com hub LISTEN/NOTIFY travou no teardown: o `cancel` do contexto do hub precisa ser registrado com `t.Cleanup` *depois* do pool (cleanups rodam em ordem inversa), senão `pool.Close()` espera a conexão do LISTEN.
2026-10-01 · sqlc: uuid anulável vira `pgtype.UUID`; configurado override para `uuid.NullUUID` em `sqlc.yaml`.
2026-10-01 · macOS não tem `timeout`; `node --experimental-strip-types` não resolve imports `./x.js` para `.ts`: rodar o runner com `npm run build && node dist/main.js`.
2026-10-01 · Playwright: `page.evaluate` recebe a função de assinatura do DOM como string (`domSignature.toString()`), por isso `domSignature` precisa ser autocontida (sem helpers/imports).
2026-10-01 · Após reinicialização do macOS, leituras de arquivos novos ficaram lentas (~1 s) e `tsc`/`npm i` pareciam travados. Rodar em background e aguardar; `npm i` que não progride: matar e repetir.
2026-10-01 · O projeto vive em `~/Desktop` (iCloud) e `node_modules` novos disparam Spotlight/iCloud/Gatekeeper: `vitest` falhou com `Timeout waiting for worker to respond` e `tsc` ficou minutos sem progresso. Solução: `scripts/check-node.sh web|runner [comando]` roda as checagens num container Linux (como o CI), com `node_modules` dentro do container. Ideal a longo prazo: mover o repositório para fora de pastas sincronizadas.
2026-10-01 · Dois `npm i` concorrentes no mesmo diretório deixaram `node_modules` inconsistente. Rode um por vez.
2026-10-01 · Web: sem `globals: true` no vitest, o Testing Library não faz cleanup entre testes (elementos duplicados). `src/setup.ts` registra `afterEach(cleanup)`.
2026-10-01 · sqlc: `numeric` precisa do override `pg_catalog.numeric` → `float64`, e `text` anulável vira `pgtype.Text` (override para `*string` em `sqlc.yaml`); `timestamptz` continua `pgtype.Timestamptz` (usar `.Time`).
2026-10-01 · zsh não divide variáveis sem aspas (`set -- $r` não separa palavras como no bash): scripts de teste em shell devem usar `read` ou arrays.
2026-10-01 · A imagem do MinIO está em `quay.io/minio/minio` (a `minio/minio` do Docker Hub não existe mais); vale para o compose e para os testes com testcontainers.
2026-10-01 · iCloud: com o repositório em `~/Desktop`, o macOS evicta arquivos ("compressed,dataless", veja `ls -lO`) e qualquer leitura (inclusive `tar`/`go test` via bind mount do Docker) trava até o download terminar, às vezes por minutos ou sem terminar. Diagnóstico: `find . -type f -print0 | xargs -0 ls -lO | grep -c dataless`. Correção: `brctl download <pasta>` e, de forma definitiva, mover o repositório para fora de pastas do iCloud (ex.: `~/dev`). `scripts/go-test.sh` e `scripts/check-node.sh` copiam o código para dentro do container, mas dependem de os arquivos estarem baixados.
2026-10-01 · `sqlc.narg` em `COALESCE(..., 'valor')` gera `interface{}`; use `sqlc.narg('x')::text` para obter `*string`.
2026-10-01 · O E2E do runner roda em container Playwright (`scripts/e2e-runner.sh`), igual ao CI; no macOS a primeira carga de binários novos é lenta.
2026-10-01 · Go: um `*Gateway` nil atribuído a uma interface não é nil; em `main.go` só se atribui ao `Completer` quando o gateway existe, senão o fallback 503 nunca dispara.
2026-10-01 · Testes de componentes que dependem do endereço (`#/mapa`): o `hashchange` do jsdom é assíncrono, então use `waitFor`; e os testes que precisam do mapa definem `window.location.hash = "#/mapa"` antes de renderizar (o padrão agora é a Visão geral).
2026-10-01 · Modelo local (Docker Model Runner, Qwen2.5 7B) num MacBook de 16 GB com o Docker e outros apps abertos: com pouca memória livre o sistema entra em swap e a geração cai para ~2 tokens/s; a extração de uma spec de 13 itens passa dos 120 s do gateway e dá 502 ("requirement extraction failed"). Solução: `LLM_TIMEOUT_SECONDS` (o compose usa 900 em dev) e, se possível, fechar apps pesados ou usar um modelo menor/hospedado. Rodar testes Go (Postgres via testcontainers) ao mesmo tempo que o modelo e as duas stacks derrubou o Docker Desktop; rode-os com o resto parado.
2026-10-01 · Modelos pequenos/locais devolvem o JSON embrulhado em cerca de markdown (```json ... ```) ou com uma frase em volta, mesmo pedindo "só JSON"; o cruzamento rejeitava tudo ("cross-reference returned invalid output", 502). O gateway agora extrai o objeto JSON da resposta quando a chamada é em modo JSON (`extractJSON`, só remove o envelope; a validação estrita dos chamadores continua igual).
2026-10-01 · Portas de host do compose de dev: UI 3010, API 8083, console do MinIO 9090 (por dentro: nginx 8080, control-plane 8080, MinIO API 9000/console 9001, Postgres 5432). A 8082 é do Evolution API do coletadoc; quem mapeia portas só muda o lado esquerdo de `ports` e nunca as portas internas (`DATABASE_URL`, `CONTROL_PLANE_URL` e o `proxy_pass` do nginx usam as internas).
2026-10-01 · O runner só enviava os eventos de exploração no fim do job (`sink.flush()` depois do crawl), então a UI não mostrava andamento nenhum: o grafo aparecia inteiro ao terminar. Agora o `EventSink` envia a cada 1 s; coberto por testes do sink (`startAutoFlush`) e do `runJob` (eventos chegam com o job ainda rodando).
2026-10-01 · Login do runner em apps Rails/Turbo e SPAs: o formulário é enviado por `fetch` e a página é trocada no lugar, então não há navegação nem novo evento `load`; esperar `waitForLoadState("load")` após o Enter dava falsa falha de login. Agora o driver espera o campo de senha sumir (até 6 s) e só depois confere; credencial errada deixa o campo na tela e o login falha após o timeout. Coberto por `runner/e2e/login-turbo.e2e.test.ts`.
2026-10-01 · Apps Rails em desenvolvimento só aceitam `Host` de IP/localhost (proteção contra DNS rebinding): um runner em container chamando `http://host.docker.internal:PORTA` recebe 403. Solução sem mexer no código do app alvo: variável `RAILS_DEVELOPMENT_HOSTS=host.docker.internal` no ambiente dele. Diagnóstico: `curl -H "Host: host.docker.internal:PORTA" http://localhost:PORTA/up` (200 = liberado, 403 = bloqueado).
2026-10-02 · `UpsertNode` só mescla `app_roles`: o `metadata` do nó fica fixo no primeiro insert. A exploração interativa precisa decidir o que vai nele **antes** de emitir o nó (a tela é examinada antes de `node_discovered`), senão o resumo nunca chega ao grafo.
2026-10-02 · sqlc: subquery com `organization_id` sem alias dá "column reference is ambiguous"; use alias nas tabelas (`l`, `p`, `b`, `r`). Colunas uuid anuláveis pedem `uuid.NullUUID` (ex.: `DetachBugsFromRequirement`).
2026-10-02 · Testes de runnerapi que criam a própria spec `v1` quebram com a spec automática (a exploração concluída já cria uma): use `f.dropAutoSpec()` depois do `/complete` quando o teste é sobre specs escritas à mão.
2026-10-02 · Num teste de passos de formulário, o 1º `step_finished` é o da página; filtre pelos passos cuja chave contém `#FORM` (o helper `runForms` já faz isso).
2026-10-04 · O React Flow desliga os eventos de ponteiro de nós que não podem ser arrastados nem selecionados, então os cartões do fluxograma (com botões dentro) ficavam **sem clique**; só o navegador real mostrou (o teste de jsdom troca o gráfico por um mock). Os nós levam `style.pointerEvents: "all"` (`flowNodes`, testado) e a raia `none`.
2026-10-04 · Esperar o `networkidle` do Playwright em toda visita multiplicou o tempo por 40 (cada página +1,5 s) e o critério "conteúdo vazio" confundia páginas pequenas com casca de SPA (+2 s). Hoje: rastreio das requisições em andamento, janelas curtas, e esperar conteúdo só se a página tem scripts. Meça com uma visita isolada antes de aumentar qualquer espera.
2026-10-04 · `detectSoftError` não pode olhar o `<body>` inteiro: layouts reais têm menu e formulário de "Sair" também na tela de erro. Mede o `<main>` e só desiste se houver campo de entrada.
2026-10-04 · O `sqlc` reclama de "organization_id is ambiguous" em CTE sem alias na tabela; use `FROM nodes mn WHERE mn.organization_id`.
2026-10-04 · Explorar com o app de exemplo na máquina: `PORT=3099 node fixtures/sample-app/server.mjs` e, no ambiente do QA, `http://host.docker.internal:3099/` (o runner roda em container).
2026-10-05 · No macOS o `tar` dentro de `scripts/go-test.sh` pode ficar horas em estado de espera de disco (iCloud/Spotlight) e o teste "trava" sem saída; `docker ps` mostra o container vivo e `docker exec <c> ps aux` mostra o `tar` em `D`. Mate o container (`docker kill`) e rode de novo. `timeout` e `sed -i` do BSD não existem como no Linux (use `perl -pi -e`).
2026-10-05 · `SELECT DISTINCT … ORDER BY CASE …` no Postgres exige a expressão na lista do SELECT: use `GROUP BY` quando a ordem depende de uma coluna agrupada.
2026-10-05 · A falha "start postgres … context deadline exceeded" nos testes Go é o Docker lento sob carga, não código: rode o pacote de novo.
2026-10-05 · `context.request` do Playwright (usado para os GET sem seguir redirecionamento) **não passa pelo `context.route`** que faz o escopo de rede: a checagem de `allowed_hosts` precisa ser feita à mão antes de cada chamada (`probe`/`rawGet` do driver), e o redirecionamento nunca é seguido (`maxRedirects: 0`).
2026-10-05 · O `Set-Cookie` cru é a única fonte do que o app disse sobre SameSite: `context.cookies()` do Playwright devolve um valor mesmo quando o app não disse nada, então não dá para separar "não declarado" de "None". O driver lê o cabeçalho (`response.headerValue("set-cookie")`, linhas separadas por `\n`) em toda resposta de documento/XHR e mantém um `CookieJar`.
2026-10-05 · As injeções devem partir do endereço **pedido**, não do endereço final: `/sec/go?next=…` redireciona e o `view.url` já perdeu a query. A exploração passa `item.url` para a checagem; e as injeções só rodam depois de tudo que age na tela (examinar, miniatura), porque levam o navegador para outros endereços.
2026-10-05 · Os E2E que contam o que o uploader recebeu (miniaturas, evidências da regressão) precisam de `no_security: true`: as verificações também guardam evidência (JSON) e o teste passaria a contar o que não é dele.
2026-10-05 · Login em duas etapas com `<input type="email">`: o navegador **barra o "Próximo" com validação HTML5** se o usuário configurado não tem `@` (o clique não envia e a página não muda). Configure o e-mail inteiro na credencial; o runner nunca tenta contornar a validação.
2026-10-05 · `page.evaluate` durante uma navegação lança ("Execution context was destroyed"): a leitura da tela de login tenta de novo (até 5 vezes), e "o campo de senha sumiu" também vale quando a página foi trocada debaixo da leitura.
2026-10-05 · O runner só considera a aplicação fora do ar quando o **navegador falhou e o `fetch` do próprio runner também**: um fetch que falha sozinho (proxy corporativo, TLS) não bloqueia nada, e um 500 da própria aplicação nunca é "fora do ar".
2026-10-05 · Verificação de segurança dos passos: `step_started` aceita `node_fingerprint` (a exploração não conhece ids), mas não junto com `node_id`; `security.check` é um id curto `[a-z0-9-]`, e um check que a UI não conhece nunca é descartado, só aparece com o id.
2026-10-07 · Captura de sessão remota: transmitir os quadros só **depois** de `await page.goto()` deixava o diálogo preso em "Aguardando o navegador…" quando o site de login (SSO/B2C) demorava ou redirecionava — nenhum quadro saía. Correção (`runner/src/capture/remote.ts`): iniciar o `setInterval` de screenshots **antes** do goto, navegar em segundo plano (`void page.goto(..., { waitUntil: "commit" })`), e tirar o screenshot com `timeout` e uma trava `sending` para não empilhar captura lenta. Verificado contra o app real: ~2,5 quadros/s fluindo. Limite conhecido: o laço de captura processa **uma sessão por vez**; uma sessão presa só libera o runner ao ser cancelada ou expirar (10 min).
2026-10-07 · No compose, reiniciar o control-plane e reconstruir o runner juntos gera uma corrida: o runner sobe antes do control-plane e o `register` falha com "fetch failed" (fatal, o container sai). Subir o runner depois do control-plane ficar pronto (`docker compose up -d runner`) resolve; uma política de restart/retry no register ficaria melhor (não feito).
2026-10-07 · O build do Docker não bate com o CI: `scripts/check-node.sh` roda `tsc --noEmit` (que no runner usa `tsconfig.json`, não o `tsconfig.build.json` do `npm run build`), então uma quebra só do build passa batido. Duas quebras assim: (1) runner — `tsconfig.build.json` não enxergava `@types/node` (erro `Cannot find name 'process'`/`node:crypto`); o base auto-inclui os `@types`, o de build não, então foi preciso `"types": ["node"]` no `tsconfig.build.json` (o DOM vem do `lib` padrão, e o build exclui os testes, então não precisa de `@types/jsdom`). (2) web — faltava `src/vite-env.d.ts` com `/// <reference types="vite/client" />`, sem o qual `tsc` acusa `TS2882` nos `import "./x.css"` (imports de efeito colateral de CSS). Correção aplicada em ambos; ideal seria o CI rodar `npm run build` de verdade (não feito).
2026-10-07 · Falso positivo de `sso_blocked`: o detector usava qualquer host bloqueado fora de `allowed_hosts`, inclusive assets de terceiros (fontes e tags), e derrubava logins normais com erro de SSO. Correção: a decisão de SSO agora olha só bloqueios relevantes de autenticação (navegação/documento e `xhr/fetch`), mantendo assets bloqueados fora da decisão de login.

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
| `PUBLIC_URL` | URL pública da UI, usada nos links de run devolvidos ao CI (opcional) |
| `QACTL_SERVER`, `QACTL_TOKEN` | usadas pelo `qactl` (CI): URL do control plane e token de projeto |
| `ENCRYPTION_KEY` | chave de criptografia dos segredos |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | SSO |
| `LLM_PROVIDER`, `LLM_ENDPOINT`, `LLM_API_KEY`, `LLM_MODEL_<TAREFA>` | gateway de LLM |
| `RUNNER_BOOTSTRAP_TOKEN` | registro de runners |
| `CONTROL_PLANE_URL`, `RUNNER_TOKEN`, `RUNNER_LABELS` | runner |
| `MULTI_TENANT` | `false` agora; `true` no modo SaaS |
| `HTTP_ADDR` | endereço do control plane (padrão `:8080`) |
| `AUTH_MODE` | `oidc` (padrão; exige `OIDC_ISSUER` e `OIDC_CLIENT_ID`) ou `dev` |
| `DEFAULT_ORG_NAME`, `DEFAULT_ORG_SLUG` | organização única do modo interno (padrão KPMG/`kpmg`) |
| `LLM_API_VERSION` | versão da API do Azure OpenAI (padrão `2024-10-21`) |
| `LLM_TIMEOUT_SECONDS` | tempo máximo de uma chamada ao provedor de LLM (padrão 120, de 10 a 3600); modelos locais num notebook podem precisar de vários minutos |
| `STORAGE_DRIVER`, `STORAGE_ENDPOINT`, `STORAGE_RUNNER_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_USE_SSL` | storage de evidências (`s3`, que inclui MinIO; vazio desliga as evidências, padrão do bucket: `evidence`) |
| `RUNNER_NAME`, `RUNNER_BOOTSTRAP_TOKEN` | runner: nome e token para registrar-se quando não há `RUNNER_TOKEN` |

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

**Status (2026-10-01):** todas as fatias do roadmap (0 a 9) estão implementadas e verificadas com testes, lint e scans: fundação, projetos/specs, runner e exploração, cruzamento e pendências, execução e histórico, bugs e relatório, gatilhos, API (OpenAPI e executor `api`), `mobile_web` e `terminal`. A UI tem a tela de configuração (botão Configurar). Pendências conhecidas: Azure Blob como driver de storage, `judge_result` por LLM, regras/ordem de chamadas de API inferidas por LLM, corpos de requisição gerados a partir do schema, autenticação de API por papel, bugs vindos da exploração (sem requisito), migração de links humanos entre versões de grafo, cruzamento automático (com IA) após a exploração, refresh de token OIDC, editar/remover projetos e ambientes pela UI, progresso real (por etapa) da ingestão de specs com LLM (hoje indeterminado), limites de CPU/memória e allowlist de binários no terminal, orquestrador que sobe runners efêmeros de terminal, modo SaaS multi-tenant, exportação para Azure DevOps/Jira e relatório em PDF.

**Status (2026-10-02):** exploração interativa (formulários, botões, modais, endpoint por verbo), várias specs com "rodar só esta", spec automática, editar/excluir specs e requisitos e evidência de cada checagem (entradas, requisições, HTTP) estão implementados e verificados (Go, runner, web, E2E em navegador real, lint e scans). Pendências novas: limite de ações por orçamento na UI (`max_actions` só pela API), regressão que cobre formulários só em ambiente com política `allow` (senão `skipped`), "Reproduzir" de bug de formulário, evidência em vídeo/trace, migração dos links `human` para a spec regerada.

**Status (2026-10-04):** cores do mapa por resultado, vários usuários (explorar, testar como, relatório e UI por usuário), mapeamento com espera de estabilização, links revelados, tela de erro com 200 e retry de instabilidade, e o módulo de Fluxos com miniaturas estão implementados e verificados (Go, runner, web, E2E em navegador real e a página Fluxos vista numa stack de verdade). Do pedido de "app grande" faltavam continuar uma exploração interrompida e explorar um usuário só sem apagar o mapa dos outros: feitos em 2026-10-05 (2ª parte).

**Status (2026-10-05):** revisão geral para a POC: bugs sem duplicata entre usuários, spec automática por ambiente e mais rica (com validação de formulário), extração e cruzamento de specs em lotes, passos paginados no servidor, regressão com vários navegadores, relatório geral exportável (HTML/PDF, Markdown, JSON) com resumo por IA em formato fixo, Visão geral com pontos de atenção e prontidão, e Fluxos mostrando a cobertura de requisitos por tela. Roteiro da demonstração em `docs/poc-demo.md`.

**Status (2026-10-05, 2ª parte):** exploração de um usuário só sem apagar o mapa dos outros, continuar uma exploração interrompida (com botão em Execuções e no diálogo) e as **verificações de segurança** (XSS refletido, SQL injection por erro, CSRF, cookies, cabeçalhos, redirecionamento aberto, arquivos expostos, CORS, mensagens de erro) dentro da exploração e da regressão, com bugs de categoria própria, relatório e seção no relatório geral. Verificadas com um app plantado (`fixtures/sample-app`, `/sec`) em navegador real. Fica de fora: POST com payload (XSS armazenado e SQL injection por formulário), controle de acesso e o resto de um pentest.

**Status (2026-10-05, 3ª parte):** login robusto (acha a tela atrás de link, de script ou em duas etapas; falha com motivo em vez de mapear só a área pública) e run bloqueada (aplicação fora do ar ou login barrado viram um aviso só, sem bug e sem apagar o mapa). Verificados em navegador real com variações de login (`fixtures/sample-app`: `/lp`, `/two`, `/otp`, `/cap`, `/sso`). Ainda fora: captcha, 2FA e SSO (o agente avisa, não resolve).

**Status (2026-10-07):** autenticações complexas de forma genérica (`docs/autenticacao.md`): reuso de sessão (`kind=session` + `npm run capture`, escopo `credential:write`, expiração → run bloqueada) e semente TOTP (`kind=login` + `totp_secret`, RFC 6238) implementados e verificados (runner unit + e2e em navegador real contra `fixtures/sample-app` `/otp` e `/lp`, Go nos pacotes `environment` e `ci`, web). Captcha, SMS/push e SSO deixam de ser um beco sem saída: são cobertos pelo reuso de sessão (a pessoa passa uma vez na captura). Depois disso: credencial de login só com usuário, editar/excluir credenciais, e **captura de sessão pela interface** (navegador remoto no runner transmitido à UI por SSE/HTTP, `internal/capture` + `CaptureDialog` + `runner/src/capture`), verificada com testes Go (hub + integração ponta a ponta), runner e web. Fora: captura multi-instância, `kind=steps`, OIDC programático, refresh automático de sessão.

**Depois:** exportação para Azure DevOps/Jira, relatório em PDF, modo SaaS multi-tenant, teste de invasão (pentest) como executor próprio.

---

## 18. Questões em aberto

- Nome do produto.
- Aprovação interna da KPMG (uso de IA, dados de clientes em testes, hospedagem).
- Onde roda na KPMG (Azure? Kubernetes interno?) e qual storage é aprovado.
- Política de retenção de evidências (vídeos e traces ocupam muito espaço).
- Política padrão de ações destrutivas para ambientes novos.
- Limites padrão de orçamento por run (tempo, custo, profundidade).
- (Resolvida em 2026-10-01) Executor `terminal`: ver a seção 13.

---

## 19. Convenções de código

- **Go:** pacotes por domínio; erros com contexto (`fmt.Errorf("...: %w", err)`); SQL só via `sqlc`; toda query filtra por `organization_id`; nada de ORM.
- **TypeScript:** `strict`; validar com `zod` tudo que cruza fronteira (protocolo, saída de LLM); sem `any`.
- **Commits:** pequenos, mensagem no imperativo, com teste junto.
- **Idioma:** código e identificadores em inglês; documentação e UI em português.
