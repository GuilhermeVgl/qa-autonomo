# Autenticação: superando logins complexos

> Como o agente entra em aplicações com qualquer tipo de autenticação (SSO, 2FA, captcha, magic link, passkey, IdP
> corporativo), de forma genérica e sem código por provedor. Decisão de produto de 2026-10-07.

## O princípio

Não existe forma genérica de **derrotar** captcha, SMS/push, passkey ou um provedor de identidade arbitrário sem quebrar o
próprio controle de segurança. A maneira agnóstica de provedor de passar por qualquer autenticação é **não executar o
login** — e sim **reutilizar uma sessão já autenticada**. Uma pessoa (ou o IdP) faz a parte difícil uma vez; o runner
replica a sessão. Isso funciona com tudo, por construção.

A autenticação é tratada em camadas, da mais genérica à mais específica. O runner escolhe pelo `kind` da credencial do
ambiente.

## O que foi implementado (2026-10-07)

### 1. Reuso de sessão — `kind=session` (a saída universal)

Guarda, por usuário (`app_role`), um **`storageState` do Playwright** (cookies + localStorage + sessionStorage), cifrado
como as demais credenciais (AES-256-GCM, `ENCRYPTION_KEY`). O runner carrega o estado em
`browser.newContext({ storageState })` **em vez** de executar qualquer login. Como o agente nunca faz o login, serve para
**qualquer IdP/fluxo**: SSO, 2FA, captcha, magic link, passkey.

- **Captura (a) pela própria interface — navegador remoto (recomendado):** em Configurações → Credenciais, digite o nome
  do usuário e clique em **"Capturar sessão (SSO/2FA)"**. O runner abre um navegador cuja tela é transmitida ao diálogo
  como quadros JPEG; você loga ali mesmo (SSO/2FA/captcha) e, em **"Concluir login"**, o runner guarda a sessão. Sem CLI,
  sem token. Não dá para capturar "puro no navegador" da UI: por **Same-Origin Policy** a página do control plane não lê
  cookies/`localStorage` de outro site, e o cookie de sessão é **HttpOnly** (invisível ao JavaScript) — por isso o
  navegador roda no runner e é transmitido. Transporte (sem dependência nova, instância única): quadros por **SSE**
  (`GET /api/v1/capture/{id}/stream`), input por **HTTP** (`POST /api/v1/capture/{id}/input`); o runner faz lease
  (`POST /runner/v1/capture/lease`), envia quadros e aplica o input via Playwright, e entrega o `storageState`
  (`POST /runner/v1/capture/{id}/result`). O estado vivo fica em memória no control plane (`internal/capture`); só a
  credencial `session` é persistida e cifrada.

- **Captura (b) pela linha de comando:** `npm run capture` (no pacote `runner`, usa Playwright) abre um navegador
  **visível**, a pessoa faz o login uma vez, e o `storageState` é enviado cifrado ao control plane. O navegador da captura
  **não** tem trava de host — o login pode passar pelo domínio do IdP.

  ```sh
  cd runner && npm run build
  npm run capture -- --server https://cp.interno --token qat_... --env homolog --role admin --url https://app.interno
  ```

  O token é um **token de projeto** (`qat_...`) com a escopo **`credential:write`** (marque "Permitir salvar sessões
  capturadas" ao criar o token em Configurações → Tokens de CI).

- **Entrega (CLI):** `PUT /ci/v1/credentials/session` (body `{ environment, app_role, state }`), cifra `{state}` e faz
  upsert de uma credencial `session`. Auditado (`credential.upsert`, só papel e tipo, nunca a sessão). O control plane
  repassa a credencial decifrada ao runner apenas no lease do job (como as demais).

- **Expiração:** sessões expiram. Ao entrar, o runner abre a URL base; se a home mostrar parede de login (formulário,
  primeiro passo, ou link "Entrar"), a sessão **expirou** → a run fica **bloqueada** com o motivo `session_expired` e a
  mensagem "recapture com `npm run capture`" (reusa o mecanismo de run bloqueada; não vira bug, não apaga o mapa).

### 2. Semente TOTP no login de senha — `kind=login` + `totp_secret`

Para o segundo fator automatizável mais comum (apps autenticadores: Google Authenticator, Authy, etc.). A credencial
`login` aceita uma chave extra opcional **`totp_secret`** (base32). Quando, depois da senha, a tela pede um código de
verificação, o runner calcula o código **RFC 6238** (SHA-1, passo de 30s) e preenche. Genérico para **todo** provedor
TOTP, sem código por provedor.

- Implementação sem dependência nova (`node:crypto`): `runner/src/executors/browser/totp.ts`.
- A análise da tela marca o campo do código e o botão (`loginpage.ts`); o preenchimento fica em `login.ts` (`passTotp`).
- Sem `totp_secret`, o comportamento anterior continua: o agente avisa "2FA, que o agente não resolve" (`needs_more`).

### 3. Login heurístico de usuário/senha (já existia)

Continua sendo o padrão zero-config para a maioria das aplicações simples (acha a tela atrás de link/script/duas etapas).
A **senha é opcional**: um login só com usuário (e-mail) é aceito, para SSO/magic-link e fluxos de primeira etapa que só
pedem o e-mail. Na UI de Credenciais, o campo de senha é opcional e há **Editar** e **Excluir**
(`DELETE /api/v1/credentials/{id}`, auditado).

### Quando o login passa por um IdP externo (SSO)

Se a aplicação redireciona o login para um domínio fora dos `allowed_hosts` (ex.: Azure AD B2C em `*.b2clogin.com`), o
agente **não** completa o login sozinho e avisa, recomendando **capturar uma sessão** (`kind=session`, `npm run capture`),
que é a via confiável para qualquer SSO/2FA/captcha. Adicionar o host do IdP aos `allowed_hosts` só ajuda se for um
provedor simples de usuário e senha (sem MFA/captcha).


## Segurança

- A sessão capturada (`storageState`) são **segredos**: cifrados em repouso, nunca devolvidos pela API, mascarados em logs
  e auditoria, entregues só no lease autenticado do job. Mesmo tratamento das credenciais de login.
- A trava de host (`allowed_hosts`), o bloqueio de produção e a política de ações destrutivas **não mudam**.
- A captura roda num navegador **sem** trava de host de propósito (o login real passa pelo IdP); nada da captura é
  persistido em disco além do upload cifrado. Os quadros e o estado vivo da captura são escopados por organização e ficam
  só em memória; o navegador remoto é controlado por uma pessoa autenticada e a sessão expira sozinha (10 min).

## O que ficou para depois

- **Receita de login gravada (`kind=steps`)**: uma sequência curta de passos para fluxos multi-etapa estranhos que a
  heurística erra. Mais robusto que a heurística, ainda não vence captcha.
- **OIDC/OAuth programático (ROPC/token endpoint)**: buscar token no servidor e injetar como cookie/bearer. "Genérico"
  apenas dentro do padrão OIDC; muitos IdPs corporativos desabilitam ROPC. Nicho.
- **Refresh automático de sessão** antes de bloquear: hoje, sessão expirada → run bloqueada pedindo recaptura (decisão de
  produto). Não há tentativa de renovar a sessão sozinho.
- **2FA por SMS/e-mail/push e captcha**: não automatizados por decisão — são delegados ao **reuso de sessão** (a pessoa
  passa uma vez na captura e o agente reusa a sessão).
- **Captura remota multi-instância (SaaS)**: o estado vivo da captura fica em memória no control plane (ok com uma
  instância, como no compose); vários control planes exigiriam roteamento com afinidade ou um transporte compartilhado.

## Arquivos principais

| Onde | O quê |
|---|---|
| `runner/src/executors/browser/totp.ts` | cálculo TOTP (RFC 6238), sem dependência |
| `runner/src/executors/browser/loginpage.ts` | marca o campo do código 2FA |
| `runner/src/executors/browser/login.ts` | preenche o código TOTP após a senha (`passTotp`) |
| `runner/src/executors/browser/driver.ts` | carrega `storageState` (`kind=session`) e detecta expiração |
| `runner/src/capture.ts` | `npm run capture`: abre o navegador e envia a sessão cifrada |
| `runner/src/capture/remote.ts` + `input.ts` | captura remota: screenshots, injeção de clique/tecla |
| `control-plane/internal/capture/` | hub em memória + endpoints da UI (criar, SSE, input, finish) |
| `control-plane/internal/runnerapi/capture.go` | endpoints do runner (lease, frame, poll, result) |
| `control-plane/db/migrations/00015_credential_session.sql` | `kind` passa a aceitar `session` |
| `control-plane/internal/environment/http.go` | valida `kind=session` (exige `state`); `login` exige só `username`; `DELETE /api/v1/credentials/{id}` |
| `control-plane/internal/ci/http.go` | `PUT /ci/v1/credentials/session` (escopo `credential:write`) |
| `control-plane/internal/apitoken/http.go` | escopo `credential:write` |
| `web/src/CaptureDialog.tsx` | navegador remoto na UI (quadros por SSE, input por HTTP) |
| `web/src/Settings.tsx` | "Capturar sessão", senha opcional, Editar/Excluir credencial |
