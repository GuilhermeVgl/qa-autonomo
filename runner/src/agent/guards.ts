export type DestructivePolicy = "block" | "confirm" | "allow";

/** Scope check used by the executor's network interception (CLAUDE.md, seção 12). Exact host match only. */
export function isAllowedUrl(url: string, allowedHosts: readonly string[]): boolean {
  if (url === "about:blank") return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return allowedHosts.some((h) => h.toLowerCase() === u.hostname.toLowerCase());
}

export interface ActionInfo {
  label: string;
  href: string;
}

// whole-word match on the label (en/pt); path match on the URL
const LABEL_WORDS = /(?:^|[^\p{L}])(delete|remove|destroy|drop|erase|excluir|remover|apagar|deletar|sair|logout|sign out)(?![\p{L}])/iu;
const PATH_WORDS = /(?:^|[/_-])(delete|remove|destroy|drop|erase|excluir|remover|apagar|logout|signout)(?:$|[/_?#-])/i;

export function isDestructive(action: ActionInfo): boolean {
  return LABEL_WORDS.test(action.label) || PATH_WORDS.test(action.href);
}

/** Exploration has no human to confirm, so `confirm` behaves like `block`. */
export function shouldSkip(action: ActionInfo, policy: DestructivePolicy): boolean {
  return policy !== "allow" && isDestructive(action);
}
