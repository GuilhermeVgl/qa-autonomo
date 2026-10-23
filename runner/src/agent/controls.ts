import type { FieldInfo, FormInfo, Intent } from "./interaction.js";

// whole-word match (en/pt), so "Salvador" is not "salvar" and "Sairdo" is not "sair"
const words = (list: string): RegExp => new RegExp(`(?:^|[^\\p{L}])(?:${list})(?![\\p{L}])`, "iu");

const NEVER_LABEL = words(
  "sair|logout|log out|sign out|signout|encerrar sess[aã]o|(?:cancelar|excluir|apagar|deletar|desativar|encerrar) (?:minha )?conta|delete (?:my )?account|deactivate(?: account)?",
);
const NEVER_PATH = /(?:^|\/)(?:logout|log_out|sign_out|signout)(?:$|[/?#])/i;
const DELETE = words("delete|remove|destroy|drop|erase|discard|excluir|remover|apagar|deletar|descartar");
const EXTERNAL = words(
  "enviar|reenviar|resolicitar|solicitar|notificar|convidar|compartilhar|pagar|cobrar|comprar|publicar|send|resend|notify|invite|share|pay|charge|buy|checkout|publish",
);
const SEARCH = words("buscar|pesquisar|procurar|search|find");
const FILTER = words("filtrar|filtro|filter");
const CREATE = words("criar|novo|nova|adicionar|cadastrar|incluir|importar|create|new|add|import|register");
const SAVE = words("salvar|gravar|confirmar|concluir|finalizar|aprovar|aplicar|save|confirm|submit|apply|approve|finish");
const EDIT = words("editar|alterar|atualizar|renomear|modificar|converter|edit|update|rename|change|convert");
const TOGGLE = words("mostrar|exibir|ocultar|esconder|expandir|recolher|alternar|show|hide|expand|collapse|toggle");
const NAVIGATE = words("voltar|ver|detalhes|abrir|visualizar|baixar|back|view|details|open|download|next|previous|pr[oó]ximo|anterior");

/** What a control does, read from its name (and the address it goes to). Order matters: risk first. */
export function classifyIntent(label: string, hint: { href?: string } = {}): Intent {
  if (NEVER_LABEL.test(label) || (hint.href !== undefined && NEVER_PATH.test(hint.href))) return "never";
  if (DELETE.test(label)) return "delete";
  if (EXTERNAL.test(label)) return "external";
  if (SEARCH.test(label)) return "search";
  if (FILTER.test(label)) return "filter";
  if (CREATE.test(label)) return "create";
  if (SAVE.test(label)) return "save";
  if (EDIT.test(label)) return "edit";
  if (TOGGLE.test(label)) return "toggle";
  if (NAVIGATE.test(label)) return "navigate";
  return "other";
}

/** Deleting data and triggering things outside the app (WhatsApp, e-mail, payments) wait for `destructive_policy=allow`. */
export const needsAllow = (intent: Intent): boolean => intent === "delete" || intent === "external";

const OWN_ACCOUNT_PATH =
  /(?:^|\/)(?:profile|perfil|account|conta|my-account|my_account|me|password|senha|settings(?:\/(?:profile|account|security|senha|password))?|users\/(?:edit|settings))(?:$|[/?#])/i;
const OWN_ACCOUNT_LABEL =
  /(?:minha\s+conta|meu\s+perfil|minhas?\s+configura(?:c|ç)(?:o|õ)es|my\s+(?:account|profile)|account\s+settings|profile\s+settings|security\s+settings|(?:change|update|reset)\s+password|(?:alterar|trocar|atualizar)\s+senha|password\s+(?:settings|update))/i;
const OWN_ACCOUNT_STRONG_FIELD =
  /(?:current[_-]?password|new[_-]?password|password[_-]?confirmation|confirm(?:ar|a)(?:[_\s-]?)senha|senha(?:[_\s-]?atual|[_\s-]?nova)|two[_-]?factor|totp|mfa)/i;
const OWN_ACCOUNT_CREDENTIAL_FIELD = /(?:email|e-?mail|username|login|senha|password|nome)/i;

/**
 * Forms that likely change the authenticated person's own account (profile, e-mail, password, 2FA) are never submitted.
 * This protects the test identity across runs.
 */
export function isOwnAccountForm(form: Pick<FormInfo, "action" | "label" | "submitLabel" | "fields">): boolean {
  const surface = `${form.action} ${form.label} ${form.submitLabel}`.toLowerCase();
  if (OWN_ACCOUNT_LABEL.test(surface)) return true;
  const strong = form.fields.some((f) => OWN_ACCOUNT_STRONG_FIELD.test(`${f.name} ${f.label} ${f.type}`.toLowerCase()));
  if (strong) return true;
  const cred = form.fields.some((f) => OWN_ACCOUNT_CREDENTIAL_FIELD.test(`${f.name} ${f.label} ${f.type}`.toLowerCase()));
  return cred && OWN_ACCOUNT_PATH.test(form.action);
}

const pad = (n: number, size: number): string => String(n).padStart(size, "0");

/**
 * A plausible value for a field, unique per run (`n`). `null` means leave it alone: files, passwords (changing a
 * password could lock the test account), hidden fields (CSRF tokens) and selects without real options.
 */
export function fakeValue(f: FieldInfo, n: number, today: Date = new Date()): string | boolean | null {
  const hint = `${f.name} ${f.label} ${f.placeholder}`.toLowerCase();
  const day = today.toISOString().slice(0, 10);
  const fit = (s: string): string => (f.maxlength && f.maxlength > 0 ? s.slice(0, f.maxlength) : s);
  switch (f.type) {
    case "file":
    case "password":
    case "hidden":
    case "submit":
    case "button":
    case "image":
    case "reset":
      return null;
    case "checkbox":
    case "radio":
      return true;
    case "select":
      return f.options[0] ?? null;
    case "email":
      return fit(`qa.${n}@exemplo.invalid`);
    case "tel":
      return `(11) 9${pad(1000 + n, 4)}-${pad(2000 + n, 4)}`;
    case "url":
      return "https://exemplo.invalid";
    case "number":
    case "range":
      return f.min ?? "10";
    case "date":
      return day;
    case "datetime-local":
      return `${day}T10:00`;
    case "time":
      return "10:00";
    case "month":
      return day.slice(0, 7);
    case "textarea":
      return fit(`Texto de teste QA ${n}`);
  }
  if (f.type === "search" || /(^|\W)(q|query|search|busca|termo)(\W|$)/.test(f.name.toLowerCase())) return "teste";
  if (/cnpj/.test(hint)) return "11.222.333/0001-81";
  if (/cpf/.test(hint)) return "529.982.247-25";
  if (/e-?mail/.test(hint)) return fit(`qa.${n}@exemplo.invalid`);
  if (/phone|telefone|celular|whatsapp/.test(hint)) return `(11) 9${pad(1000 + n, 4)}-${pad(2000 + n, 4)}`;
  if (/name|nome/.test(hint)) return fit(`Cliente QA ${n}`);
  return fit(`Teste QA ${n}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^(?=.*\d)[0-9a-f]{16,}$/i;

/** Path template of an endpoint: ids become `{id}`, the same notation OpenAPI uses, so spec and observation merge. */
export function endpointPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean).map((s) => (/^\d+$/.test(s) || UUID.test(s) || LONG_HEX.test(s) ? "{id}" : s));
  return "/" + segments.join("/");
}

/** Browsers only send GET/POST; frameworks like Rails carry the real verb in a `_method` field. */
export function effectiveMethod(method: string, body: string | null): string {
  const m = method.toUpperCase();
  if (m !== "POST" || !body) return m;
  const override = /(?:^|&)_method=([a-zA-Z]+)/.exec(body)?.[1]?.toUpperCase();
  return override === "PUT" || override === "PATCH" || override === "DELETE" ? override : m;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const FRAMEWORK_FIELDS = new Set(["authenticity_token", "_method", "utf8", "csrf_token", "_csrf"]);

/** Names of the body fields of a request (never the values, which may carry secrets). */
export function formEncodedFields(body: string | null, contentType: string | null): string[] {
  if (!body) return [];
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
    } catch {
      return [];
    }
  }
  if (type.includes("urlencoded")) {
    const names = body
      .split("&")
      .map((pair) => safeDecode((pair.split("=")[0] ?? "").replace(/\+/g, " ")))
      .filter((name) => name !== "" && !FRAMEWORK_FIELDS.has(name));
    return [...new Set(names)];
  }
  return [];
}
