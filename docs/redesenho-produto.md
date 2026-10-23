# Especificação de desenvolvimento — Redesenho para valor de produto

> Destinatário: uma IA de desenvolvimento (ou pessoa) que vai **implementar** este plano.
> Fonte da verdade do projeto: `CLAUDE.md` na raiz. **Leia-o antes de começar.**
> Esta spec descreve **o quê** e **por quê**; o **como** segue as convenções do `CLAUDE.md`.
> Versão: v1 · 2026-10-09

---

## 0. Como usar esta spec

1. **TDD sempre.** Teste primeiro, código depois. Nenhuma linha de produção sem teste que a justifique (`CLAUDE.md` §2).
2. **Fatias pequenas e independentes.** Cada fatia (§3–§6) vai para produção sozinha, passa no CI (`CLAUDE.md` §15) e não quebra as demais. Não comece a próxima antes da anterior estar verde.
3. **Sem over-engineering.** Resolva o problema de hoje. Sem framework novo, sem abstração especulativa (`CLAUDE.md` §2).
4. **Registre no `CLAUDE.md`.** Toda decisão vira linha na §13; todo hurdle técnico vira linha na §14, **no mesmo commit** que o originou.
5. **Idioma.** Código e identificadores em inglês; UI e docs em português (`CLAUDE.md` §19).
6. **Convenções de stack:** Go com `sqlc` e `organization_id` em toda query; TypeScript `strict`, `zod` em fronteiras, sem `any`; React + Vite (`CLAUDE.md` §19).

### Princípio que amarra tudo

O app foi construído **de baixo para cima a partir do DOM**: ele entrega um **artefato técnico** (grafo de rotas + checks operacionais). Quem compra QA quer um **artefato de negócio**: "o que meu app faz, o que testamos, o que quebrou, qual o risco". Os três sintomas relatados (mapa pouco claro, specs estranhas, fluxos que "entram numa rota e despejam a resposta") são o **mesmo** artefato técnico vazando para o usuário em três telas. O redesenho introduz uma **camada semântica** entre o grafo técnico (que permanece como substrato) e o que o usuário vê.

**Importante:** o dado necessário para as Fatias 1 e 2 **já é coletado** hoje (inventário de tela: forms, controles, ações, em `node.metadata`). Elas são reorganização de apresentação, não nova coleta.

---

## 1. Estado atual (mapa de código relevante)

### Runner (coleta)
- Fingerprint do nó: `routePattern + domSignature + role` em `runner/src/fingerprint/fingerprint.ts`. O `domSignature` ignora texto/conteúdo (`runner/src/fingerprint/dom.ts`). Consequência: o nó é uma rota, não uma capacidade.
- Inventário da tela (possibilidades): `runner/src/executors/browser/inventory.ts` — extrai `forms`, `buttons`, landmarks de "chrome".
- Metadado do nó (o que chega ao grafo): montado em `runner/src/agent/interactive.ts` (função `examinePage`). Shape atual do `metadata` de um nó `page`:
  ```
  {
    title: string,
    headings: string[],
    summary: string,                 // heurística ou LLM analyst
    controls: [{ label, intent, what }],        // de inventory.buttons, cap 20
    forms:    [{ label, method, action, purpose, fields: [{ name, label, type, required }] }], // cap 8, fields cap 15
    actions:  string[],              // notas condensadas de outcomes
    followed: [{ ... }],             // navegações causadas por ações, cap 10
    messages?: string[],
    dialogs?: [...],
    status: number,
    url: string,                     // origin+pathname (sem query/hash)
    query?: string[]                 // nomes de parâmetros, cap 5
  }
  ```
- Nós `endpoint` (observados) e `modal` também são emitidos por `interactive.ts`.

### Control-plane (specs)
- Autospec (determinística, sem LLM): `control-plane/internal/autospec/autospec.go`. `buildItems` gera keys `PAGE /rota`, `FORM GET /x`, `FORM POST /x`, `VALIDATE POST /x`. Texto = templates operacionais ("A tela X responde sem erro (HTTP < 400)…"). Uma spec `source_type=auto` por ambiente.
- Extração de requisitos de texto (LLM): `control-plane/internal/spec/requirements.go` — `systemPrompt`, `Extract`, chunking de 6000 chars, `Quality`/`QualityOf` (flags `vago`/`curto`/`composto`/`parecido com REQ-X`). Qualidade só julga keys `REQ-*`.
- Cobertura requisito↔nó: `control-plane/internal/pendency/http.go` (`buildCoverage`), devolve por requisito `status` (`covered`/`pending`/`unmatched`) e `node_ids`.

### Web (fluxos)
- `web/src/flows.ts`: `buildModel(graph)` colapsa nós em `Screen` por `kind|label` (`screenKey`), `edges` viram `Transition`. Origens: `detectJourneys` (usa só transições interativas observadas, descarta links de navegação), `requirementFlows` (parte de `coverage.requirements[].node_ids`), `runFlow` (usa `/runs/{id}/node-results`). `layoutFlow` monta raias por usuário, colunas por distância BFS, caixas-fantasma "sem acesso".
- `web/src/FlowChart.tsx`: render com React Flow.
- `web/src/pages/FlowsPage.tsx`: seletor de origem, consome `coverage` e `node-results`.
- Tipos: `web/src/api.ts` (`GraphNode`, `GraphEdge`, `GraphData`, `Coverage`).

---

## 2. Objetivo e não-objetivos

### Objetivo
Transformar a saída do produto de **"grafo técnico de rotas"** para **"modelo legível do app testado com verificação contínua"**, atacando os três sintomas na ordem de menor risco → maior valor.

### Não-objetivos (não fazer nesta spec)
- Não reescrever o crawler nem o fingerprint de nós.
- Não remover o autospec (ele permanece; só muda de rótulo e de lugar na UI).
- Não mexer em segurança, bugs, gatilhos, CI/CD, auth, storage.
- Não introduzir dependências novas (React Flow, zod, sqlc já existem; use-os).
- Não quebrar o mapa atual (`#/mapa`): ele continua existindo como substrato técnico / drill-down.

---

## 3. Fatia 1 — Fluxos por possibilidade da tela

**Problema que resolve:** "não mostra os fluxos com base nas possibilidades das telas, mas entra numa rota e coloca ali as respostas."

**Escopo:** somente `web/`. Client-side puro. Nenhuma mudança em runner ou control-plane. Risco baixo, reversível.

### 3.1 Ideia
Hoje o fluxo nasce só das **arestas percorridas** (`buildModel` usa `graph.edges`). Passe a derivar as saídas de cada tela também do **inventário já coletado** em `node.metadata` (`forms`, `controls`, `actions`, `followed`), e sobreponha o **status de teste** (testado / passou / falhou / não testado). O usuário deve ver, por tela: "o que dá para fazer aqui" + "o que foi verificado".

### 3.2 Modelo de dados (client-side, em `web/src/flows.ts`)
Introduzir, por `Screen`, uma lista de **possibilidades** derivada do `metadata` dos nós daquela tela (não só das edges):

```ts
type Possibility = {
  kind: "navigate" | "submit" | "search" | "open" | "action";
  label: string;              // legível: "Criar pedido", "Filtrar lista"
  target?: string;            // screenKey destino, se conhecido (de followed/edges)
  method?: string;            // para submit/search
  action?: string;            // path do form
  tested: boolean;            // houve run_step cobrindo isto?
  result?: "pass" | "fail" | "error" | "skipped" | "untested";
};
```

Fonte de cada possibilidade:
- `metadata.forms[]` → `submit` (method de escrita) ou `search` (GET). `label` = `form.purpose || form.label`.
- `metadata.controls[]` → `action`/`open` conforme `intent`. `label` = `control.label`.
- `metadata.followed[]` e `graph.edges` → preenchem `target` quando a ação leva a outra tela.
- `metadata.actions[]` → notas para enriquecer `label`/resultado.

`tested`/`result`: vêm do overlay de execução — reusar `node-results` (origem Execução) e/ou `node-status` do ambiente (`GET /environments/{id}/node-status`, já existe) para marcar o pior resultado por nó. Possibilidade sem run correspondente = `untested`.

### 3.3 Mudanças de comportamento
1. `detectJourneys`: deixar de **descartar** navegação pura. Em vez de sumir com o link, rebaixá-lo visualmente (possibilidade `navigate` de menor destaque), para o fluxo refletir o que a tela oferece, não só o que o crawler enviou.
2. Cartões de endpoint-request **saem do fluxo principal** e viram detalhe sob demanda (painel lateral da tela), não caixas na raia.
3. Cada caixa de tela passa a listar suas **possibilidades com marca de resultado** (✅/❌/⚠️ não testado), em vez de só a seta de saída observada.

### 3.4 UI (`web/src/FlowChart.tsx`, `web/src/pages/FlowsPage.tsx`)
- Caixa de tela mostra, além da miniatura e do resultado: até N possibilidades com ícone de status. "Ver todas" abre o painel de detalhes.
- Legenda nova: verde = testado e passou; vermelho = falhou; âmbar = possível mas não testado; cinza = navegação.
- Manter as 3 origens (Jornadas/Requisitos/Execução), mas Jornadas agora reflete possibilidades, não só trajetória.

### 3.5 Testes (TDD — escrever primeiro)
Arquivo: `web/src/flows.test.ts` (já existe; estender) e novos casos em `web/src/FlowChart.test.ts`.
- `buildModel` deriva possibilidades a partir de `metadata.forms/controls/followed`, não só de `edges`. Caso: tela com form de escrita não percorrido ainda aparece como possibilidade `submit untested`.
- Possibilidade recebe `result` correto do overlay de execução.
- Navegação pura aparece como `navigate` (não some), mas com menor destaque.
- Endpoint-request **não** vira caixa na raia (vai para detalhe).
- Funções puras, testadas sem React (como já é o padrão de `flows.ts`).

### 3.6 Critérios de aceite
- Em um ambiente já explorado, a página `#/fluxos` mostra, por tela, as ações possíveis com status, incluindo ações **não testadas**.
- Nenhuma chamada nova de backend é necessária (reusa `graph`, `coverage`, `node-results`/`node-status`).
- `tsc --noEmit`, `eslint`, `vitest` verdes (`CLAUDE.md` §15).

### 3.7 Registro
Linha na §13 do `CLAUDE.md`: "Fluxos passam a derivar das possibilidades da tela (inventário em `metadata`) com overlay de resultado, não só das arestas percorridas; endpoint-request vira detalhe."

---

## 4. Fatia 2 — Separar "requisito de negócio" de "verificação automática"

**Problema que resolve:** "specs estranhas" — a lista mistura `REQ-xxx` (negócio), `PAGE/FORM/VALIDATE` (checks operacionais) e `MÉTODO /path` (OpenAPI), e a qualidade só julga `REQ-xxx`.

**Escopo:** principalmente `web/` (apresentação). Opcionalmente um campo derivado no control-plane para classificar a origem. **Não** apagar dados: o autospec continua gerando o que gera.

### 4.1 Ideia
Na UI de Especificações, separar em dois grupos com rótulos claros:
- **Requisitos** — o que o sistema **deveria** fazer, em linguagem de negócio. Origem: specs humanas e extração LLM (`REQ-*`). Têm qualidade.
- **Verificações automáticas** — o que o agente **checa sozinho** (a tela responde, valida obrigatórios, etc.). Origem: autospec (`PAGE/FORM/VALIDATE`) e OpenAPI de contrato. Mostradas como **cobertura técnica**, não como "requisitos".

### 4.2 Como classificar (determinístico, sem LLM)
Derivar a categoria da **key** e do `source_type` da spec:
- Spec `source_type ∈ {text, document}` → requisitos de negócio.
- Spec `source_type = auto` → verificações automáticas.
- Spec `source_type = openapi` → verificações de contrato (grupo técnico).
- Dentro de uma spec, a key `REQ-*` é negócio; `PAGE/FORM/VALIDATE/MÉTODO path` é técnico.

Implementação sugerida: um campo derivado `category: "business" | "technical"` no `reqView` (`control-plane/internal/spec/manage.go`), calculado da key/`source_type`. **Não** é coluna nova no banco (é derivação em tempo de leitura), para não exigir migração.

### 4.3 UI (`web/src/pages/` da seção Especificações)
- Duas abas/seções: "Requisitos" e "Verificações automáticas".
- Qualidade (`vago`/`curto`/`composto`/`parecido`) só aparece em Requisitos (coerente com `QualityOf` que só julga `REQ-*`). Fim da sensação de "lista pela metade".
- Cobertura continua por spec; só a **apresentação** separa as naturezas.
- A "spec do projeto" (cruzamento padrão) continua sendo a humana mais recente (`GetLatestSpec` já exclui `auto`). Não mudar essa regra.

### 4.4 Testes (TDD)
- Go: `control-plane/internal/spec/manage_test.go` — `reqView.Category` = `technical` para `PAGE /x`, `business` para `REQ-1`; `auto` spec → todos `technical`.
- Web: teste de componente da página de specs mostrando dois grupos e qualidade só no grupo de negócio.

### 4.5 Critérios de aceite
- A UI de Especificações nunca mistura `REQ-*` com `PAGE/FORM/VALIDATE` na mesma lista.
- Nenhuma migração de banco. Nenhum dado perdido.
- CI Go + web verdes.

### 4.6 Registro
Linha na §13: "Specs na UI separam `Requisitos` (negócio, com qualidade) de `Verificações automáticas` (autospec/OpenAPI, técnicas); categoria derivada da key/`source_type` em `reqView`, sem coluna nova."

---

## 5. Fatia 3 — Camada de Capacidades (features de negócio)

**Problema que resolve:** "mapeia as coisas de forma não muito clara." Não existe nada entre "400 nós técnicos" e "o app". Esta é a fatia de **maior valor e maior risco**.

**Escopo:** control-plane (Go, novo domínio + LLM) + web (nova tela). Runner inalterado.

### 5.1 Ideia
Agrupar telas (nós `page`) em **~10–20 capacidades com nome de negócio** ("Autenticação", "Gestão de pedidos", "Cadastro de cliente"), inferidas por LLM a partir do inventário **já coletado** (título, resumo, forms, controles por tela), com **validação estrita e fallback determinístico** — exatamente o padrão já usado no cruzamento spec×grafo (`CLAUDE.md` §13, entrada de crossref) e na extração de requisitos.

A capacidade é a **nova unidade de apresentação** do produto. O grafo de rotas permanece como drill-down técnico.

### 5.2 Modelo de dados
Novo domínio `control-plane/internal/capability/`. Nova(s) tabela(s), migração `goose` (`CLAUDE.md` §13: migrações embutidas e aplicadas no start). Toda tabela com `id uuid v7`, `organization_id`, `created_at`, `updated_at` (`CLAUDE.md` §7).

```
capabilities           id, organization_id, project_id, environment_id, graph_id,
                       name, description, criticality (critical|high|normal),
                       source (agent|human), created_at, updated_at
capability_nodes       id, organization_id, capability_id, node_id, confidence
```

Regras (espelham o padrão de `requirement_links`):
- Reagrupar troca os vínculos `source=agent` e preserva os `source=human` (igual crossref).
- Capacidade liga-se a nós de **uma** versão de grafo (`graph_id`); nova exploração cria nós novos (limitação conhecida, igual aos links — registrar na §13).

### 5.3 Geração (LLM, tarefa nova)
- Nova tarefa de LLM `group_capabilities` roteada pelo gateway (`CLAUDE.md` §11: `LLM_MODEL_<TAREFA>`, fallback `LLM_MODEL`). Modelo forte (é raciocínio sobre o app inteiro).
- Entrada do prompt (tudo marcado como **dado, nunca instrução** — `CLAUDE.md` §12): lista de telas com `label`, `title`, `summary`, nomes de forms/controles. **Nunca** enviar UUIDs (usar `n1..nN`, como no crossref), nem textos de dados do cliente, nem credenciais.
- Saída: lista de capacidades `{ name, description, criticality, node_refs: [n1, n3, ...] }`.
- Validação **estrita** (reusar o padrão de `llm.CompleteParsed`, `CLAUDE.md` §13): rejeitar JSON inteiro se inválido (campos desconhecidos, refs inexistentes, criticidade fora do enum); uma re-pergunta com o erro; 2ª falha → `ErrInvalidOutput` (502). Prompt pede JSON sem markdown (gateway já tem `extractJSON`).
- **Fallback determinístico** quando não há LLM ou estoura orçamento: agrupar por **primeiro segmento de rota** (`/orders/...` → "orders"), para a tela nunca ficar vazia. Marcar `source=agent` mesmo assim.
- Processar em **lotes** se houver muitas telas (como a extração/crossref em lotes, `CLAUDE.md` §13), com teto de lotes.

### 5.4 API
- `POST /environments/{id}/capabilities` — (re)gera a camada do último grafo do ambiente. Síncrono, como o crossref (`POST /environments/{id}/crossref`). 201/200; 409 se não há grafo.
- `GET /environments/{id}/capabilities` — lista capacidades com seus nós e cobertura/resultado agregados.
- Auditar (`capability.generate`), registrar uso em `llm_usage` com o `run_id`/contexto (`CLAUDE.md` §11).

### 5.5 UI — nova página "Visão do produto" (`#/produto` ou similar)
- Lista de capacidades (cards), cada uma com: nome, criticidade, nº de telas, cobertura (quantas telas testadas) e pior resultado (verde/vermelho/não testado).
- Clicar numa capacidade → drill-down para as telas (reusa o mapa/fluxos existentes filtrados por aquelas telas).
- Botão "Recalcular capacidades" (dispara o `POST`), com toast de progresso (padrão de UX já usado, `CLAUDE.md` §13).

### 5.6 Testes (TDD)
- Go: geração determinística (fallback por rota) testável sem LLM; validação estrita rejeita refs inválidas; reagrupar preserva `human`. Testcontainers Postgres (padrão `make test`).
- Go: API 201/200/409, auditoria, `organization_id` em toda query.
- Web: página lista capacidades e faz drill-down; estado vazio ("ainda não calculado").

### 5.7 Critérios de aceite
- Em um ambiente explorado, "Visão do produto" mostra ~10–20 capacidades nomeadas, não 400 rotas.
- Sem LLM configurado, o fallback por rota ainda produz capacidades (nunca tela vazia).
- Saída de LLM inválida é rejeitada inteira (nada gravado), com re-pergunta única.
- CI Go + web verdes; `govulncheck`/`gosec` limpos.

### 5.8 Registro
Linha na §13 descrevendo o domínio `capability`, a tarefa `group_capabilities`, validação estrita + fallback por rota, preservação de vínculos `human`, e a limitação de vínculo por versão de grafo.

---

## 6. Fatia 4 — Mapa e relatório capacidade-cêntricos

**Problema que resolve:** fecha o ciclo — o entregável vendável.

**Escopo:** web (reorganização de navegação) + control-plane (brief alimentado por capacidades). Depende das Fatias 1–3.

### 6.1 Mapa
- A tela principal de "mapa" passa a abrir na **Visão do produto** (capacidades); o grafo de rotas atual (`#/mapa`) continua acessível como **detalhe técnico** ("Ver mapa técnico").
- Não apagar o grafo técnico: ele é o substrato.

### 6.2 Relatório (brief)
- `control-plane/internal/brief` passa a incluir, nos **fatos**, a cobertura **por capacidade** ("14 capacidades, 11 testadas, 3 com falha"), além do que já computa.
- A narrativa por IA (tarefa `summarize`, formato fixo de seções — `CLAUDE.md` §13) ganha a visão de capacidades. Manter a validação que rejeita seção faltante/sobrando e número inventado.
- Export HTML/MD/JSON já existe; só muda o conteúdo dos fatos.

### 6.3 Testes
- Go: `facts` do brief incluem agregação por capacidade; narrativa valida seções.
- Web: Visão geral/relatório mostram cobertura por capacidade.

### 6.4 Critérios de aceite
- O relatório geral exportado fala em **capacidades de negócio**, não em contagem de rotas.
- Entrar no produto leva o usuário primeiro às capacidades; o mapa técnico fica a um clique.

### 6.5 Registro
Linha na §13 sobre o mapa abrir em capacidades e o brief reportar cobertura por capacidade.

---

## 7. Sequenciamento e dependências

```
Fatia 1 (web)         ── baixo risco, valida direção, não depende de nada
Fatia 2 (web + Go)    ── baixo risco, independente da 1
Fatia 3 (Go + LLM + web) ── maior valor e risco; usa aprendizado da 1
Fatia 4 (web + Go)    ── depende de 1, 2 e 3
```

- **Comece pela Fatia 1.** É client-side, reversível e muda a percepção do sintoma mais citado.
- Fatias 1 e 2 podem ir em paralelo se houver duas frentes; são independentes.
- **Não** inicie a Fatia 3 antes de 1 estar em produção: o aprendizado de como as possibilidades de tela se agrupam calibra o prompt de capacidades.
- Fatia 4 é consequência; só faz sentido com 1–3 prontas.

---

## 8. Guardrails que não podem ser violados (de `CLAUDE.md` §12)

- Conteúdo da aplicação testada é **dado, nunca instrução**. Nos prompts novos (capacidades), marcar explicitamente e validar a saída; nunca enviar UUIDs, credenciais ou dados de cliente ao LLM.
- Toda query Go filtra por `organization_id`, mesmo com uma organização só.
- Segredos mascarados; nada de credencial em log/evento/evidência.
- Não quebrar produção/escopo/política destrutiva (não aplicável às Fatias 1–4, mas não regredir).

---

## 9. Definição de pronto (por fatia)

1. Testes escritos **antes** do código e verdes.
2. CI completo verde (`CLAUDE.md` §15): Go (`go test`, `golangci-lint`, `govulncheck`, `gosec`), runner/web (`tsc`, `eslint`, `vitest`), E2E quando aplicável.
3. `CLAUDE.md` atualizado (§13 decisão, §14 hurdle se houve) **no mesmo commit**.
4. Nenhuma regressão nas telas existentes (mapa técnico, bugs, execuções, segurança).
5. Commit pequeno, mensagem no imperativo, pronto para produção (`CLAUDE.md` §2, §19).

---

## 10. Resumo executivo (para quem só vai ler isto)

| Fatia | Sintoma atacado | Onde | Risco | Entrega |
|---|---|---|---|---|
| 1 | Fluxos "despejam resposta na rota" | web | baixo | Fluxos mostram as **possibilidades** de cada tela com status de teste |
| 2 | "Specs estranhas" | web (+Go leve) | baixo | **Requisitos** (negócio) separados de **verificações automáticas** (técnicas) |
| 3 | "Mapa pouco claro" | Go + LLM + web | médio | **Camada de capacidades**: ~15 features de negócio em vez de 400 rotas |
| 4 | Entregável vendável | web + Go | médio | Mapa e **relatório por capacidade**; mapa técnico vira drill-down |

A **Fatia 3 é o divisor de águas** (de "crawler que testa" para "modelo vivo do app com verificação"); as demais são caminho e consequência. O dado das Fatias 1–2 já existe no `metadata`; é reorganização, não nova coleta.
