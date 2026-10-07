/** Minimal element shape so the function runs in a browser page and under jsdom. */
export interface DomNode {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  readonly children: ArrayLike<DomNode>;
}

/**
 * Structural signature of a DOM subtree: tags, ARIA roles and form-field types only; no text, data,
 * classes or ids. Identical consecutive siblings collapse to one, so list length does not change it.
 * Self-contained on purpose: Playwright serializes it into the page via `page.evaluate`.
 */
export function domSignature(root: DomNode): string {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META"]);
  const walk = (el: DomNode): string => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : null;
    const head = tag + (role ? `[${role}]` : "") + (type ? `<${type}>` : "");
    const parts: string[] = [];
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i] as DomNode;
      if (skip.has(child.tagName.toUpperCase())) continue;
      const s = walk(child);
      if (parts[parts.length - 1] !== s) parts.push(s);
    }
    return parts.length ? `${head}(${parts.join(",")})` : head;
  };
  return walk(root);
}
