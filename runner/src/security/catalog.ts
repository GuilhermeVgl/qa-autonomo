import type { Severity } from "./types.js";

/** What each check looks for, in the words a person reads in a bug: `title` is what is wrong, `expected` what should hold. */
export interface CheckInfo {
  severity: Severity;
  expected: string;
  title: (scope: string, detail?: Record<string, unknown>) => string;
}

const route = (scope: string): string => scope.split("?")[0] ?? scope;
const param = (scope: string): string => scope.split("?")[1] ?? "";

export const CATALOG: Record<string, CheckInfo> = {
  "header-csp": { severity: "normal", expected: "As páginas enviam Content-Security-Policy, que limita de onde vêm scripts e conteúdo", title: () => "Content-Security-Policy ausente nas respostas da aplicação" },
  "header-frame": { severity: "normal", expected: "As páginas não podem ser embutidas em outro site (X-Frame-Options ou frame-ancestors)", title: () => "Sem proteção contra clickjacking (X-Frame-Options e frame-ancestors ausentes)" },
  "header-nosniff": { severity: "normal", expected: "As respostas enviam X-Content-Type-Options: nosniff", title: () => "X-Content-Type-Options: nosniff ausente" },
  "header-hsts": { severity: "normal", expected: "Em HTTPS, as páginas enviam Strict-Transport-Security", title: () => "Strict-Transport-Security (HSTS) ausente" },
  banner: { severity: "normal", expected: "O servidor não revela sua tecnologia e versão nos cabeçalhos", title: () => "O servidor revela sua tecnologia e versão (Server ou X-Powered-By)" },
  "cookie-httponly": { severity: "high", expected: "O cookie de sessão é HttpOnly: scripts da página não conseguem lê-lo", title: (s) => `Cookie de sessão "${s}" sem HttpOnly (um script injetado consegue roubá-lo)` },
  "cookie-secure": { severity: "high", expected: "Em HTTPS, os cookies têm o atributo Secure", title: (s) => `Cookie "${s}" sem o atributo Secure em HTTPS` },
  "cookie-samesite": { severity: "normal", expected: "O cookie de sessão declara SameSite (Lax ou Strict)", title: (s) => `Cookie de sessão "${s}" sem SameSite` },
  "csrf-token": { severity: "normal", expected: "Formulários que alteram dados trazem token anti-CSRF (ou a sessão é SameSite)", title: (s) => `Formulário ${s} sem token anti-CSRF` },
  "mixed-content": { severity: "normal", expected: "Páginas HTTPS não carregam recursos por HTTP", title: () => "Página HTTPS carrega recursos por HTTP" },
  "transport-http": { severity: "high", expected: "A aplicação é servida por HTTPS", title: () => "A aplicação é servida sem HTTPS" },
  "password-http": { severity: "critical", expected: "Formulários de senha são enviados por HTTPS", title: (s) => `Formulário de senha ${s} enviado sem HTTPS` },
  "info-stacktrace": { severity: "high", expected: "Erros não mostram stack trace nem modo de depuração", title: () => "Uma resposta expõe detalhes internos (stack trace ou modo de depuração)" },
  "info-sql-error": { severity: "high", expected: "Erros não mostram mensagens do banco de dados", title: () => "Uma resposta expõe uma mensagem de erro do banco de dados" },
  "info-dirlist": { severity: "normal", expected: "O servidor não lista o conteúdo de diretórios", title: () => "Listagem de diretório habilitada no servidor" },
  "cors-reflect": { severity: "high", expected: "A aplicação não aceita qualquer origem com credenciais (CORS)", title: () => "CORS aceita qualquer origem com credenciais: outro site consegue ler as respostas do usuário logado" },
  "xss-reflected": {
    severity: "high",
    expected: "O que chega pelo endereço é escapado ao ser exibido",
    title: (s) => `XSS refletido: o parâmetro ${param(s)} de ${route(s)} volta na página sem escape`,
  },
  "sqli-error": {
    severity: "critical",
    expected: "Aspas e símbolos de SQL no parâmetro não causam erro de banco de dados",
    title: (s) => `Possível SQL injection: ${route(s)} (${param(s)}) devolve erro do banco ao receber aspas`,
  },
  "injection-500": {
    severity: "normal",
    expected: "Aspas e sinais especiais no parâmetro não derrubam o servidor",
    title: (s) => `Erro 500 ao receber aspas e sinais especiais em ${route(s)} (${param(s)})`,
  },
  "open-redirect": {
    severity: "normal",
    expected: "O parâmetro de redirecionamento só aceita endereços do próprio site",
    title: (s) => `Redirecionamento aberto: o parâmetro ${param(s)} de ${route(s)} aceita um endereço de outro site`,
  },
  "exposed-file": { severity: "high", expected: "Arquivos internos (.git, .env, status do servidor) não são servidos", title: (s) => `Arquivo sensível exposto: ${s}` },
};

/** The check is one we know; an unknown one never reaches the server. */
export const knownCheck = (id: string): boolean => id in CATALOG;
