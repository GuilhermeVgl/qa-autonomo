# Rodar o QA Autônomo + ColetaDoc

Feche apps pesados antes. Cada bloco é um terminal.

## 1. Modelo de IA (uma vez)
```sh
docker model pull ai/qwen2.5:7B-Q4_K_M
docker model configure --context-size=16384 ai/qwen2.5:7B-Q4_K_M
```

## 2. ColetaDoc
```sh
cd ~/projetos/coletadoc
docker compose up -d postgres minio minio-init web jobs
```
Precisa ter `RAILS_DEVELOPMENT_HOSTS=host.docker.internal` no `.env` dele. Teste (tem que dar 200):
```sh
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: host.docker.internal:3002" http://localhost:3002/up
```

## 3. QA Autônomo
Arquivo `deploy/compose/.env`:
```
LLM_PROVIDER=openai_compatible
LLM_ENDPOINT=http://model-runner.docker.internal/engines/v1
LLM_MODEL=ai/qwen2.5:7B-Q4_K_M
LLM_TIMEOUT_SECONDS=900
```
```sh
cd ~/Desktop/projetos/agent-qa/deploy/compose
docker compose up -d --build
```

## 4. Usar
Abra http://localhost:3010 (qualquer e-mail).

1. **Configurações** → Projetos: `ColetaDoc`
2. Ambientes: nome `desenvolvimento`, Web, URL `http://host.docker.internal:3002`
3. Credenciais: papel `advogada`, usuário `qa@teste.dev`, senha `Senha-QA-12345`
4. **Especificações** → Nova especificação → cole o texto e envie
5. **Nova exploração** (aguarde terminar; no fim a spec "Varredura automática" é criada sozinha)
6. **Cruzar com a spec** (opcional, usa a IA)
7. **Nova regressão**, ou em **Especificações** escolha uma spec e clique **Rodar esta spec**
8. **Execuções** → "Checagens e evidências": valores digitados, requisições e HTTP de cada checagem

Para a regressão **inserir dados de verdade** nos formulários, o ambiente precisa da política **Permitir** (Configurações → Ambientes). Com **Bloquear** (padrão) nada é gravado e os formulários de escrita ficam "pulados". Use um banco de desenvolvimento.

Texto da spec:
```text
ColetaDoc é um microSaaS para advogados autônomos: pede, coleta e organiza documentos de clientes pelo WhatsApp.
1. Clientes: a advogada lista, busca, cria, edita e remove clientes. A lista de clientes é a página inicial.
2. Ficha do cliente: mostra dados, processos e solicitações de documentos.
3. Solicitação de documentos: da ficha do cliente, escolhe um modelo e os tipos de documento e envia pelo WhatsApp.
4. Acompanhamento: lista todas as solicitações com o status de cada uma.
5. Biblioteca de documentos: lista os documentos aprovados e permite baixar.
6. Administração: tipos de documento, modelos de mensagem e conexão do WhatsApp.
Requisitos críticos: itens 1 e 3.
```

## Desligar
```sh
cd ~/Desktop/projetos/agent-qa/deploy/compose && docker compose stop
cd ~/projetos/coletadoc && docker compose stop
```
Nunca use `down -v` (apaga os dados).
