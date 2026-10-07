import type { PageFacts } from "./types.js";

/**
 * Reads from a page what the security checks need, and nothing a person typed: the forms (where they send, the names of
 * their fields, which hidden fields they carry), whether the page hands out a CSRF token in a meta tag, resources loaded
 * over plain http, and the visible text. Self-contained on purpose: Playwright serializes it into the page via
 * `page.evaluate`, and the tests run it under jsdom.
 */
export function collectPageFacts(doc: Document, pageUrl: string): Omit<PageFacts, "headers" | "html"> {
  const clean = (s: string | null | undefined, max: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const forms: PageFacts["forms"] = [];
  for (const form of Array.from(doc.querySelectorAll("form")).slice(0, 20)) {
    const f = form as HTMLFormElement;
    const override = (f.querySelector('input[type="hidden"][name="_method"]') as HTMLInputElement | null)?.value?.toUpperCase();
    let action = pageUrl;
    try {
      action = new URL(f.getAttribute("action") || pageUrl, pageUrl).toString();
    } catch {
      // an action that is not an address: the form posts to the page itself, as far as anyone can tell
    }
    const inputs = Array.from(f.querySelectorAll("input, textarea, select")) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
    const typeOf = (el: Element): string => (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : ((el as HTMLInputElement).type || "text").toLowerCase());
    const submit = f.querySelector('button[type="submit"], button:not([type]), input[type="submit"]');
    forms.push({
      method: override === "PATCH" || override === "PUT" || override === "DELETE" ? override : (f.getAttribute("method") || "GET").toUpperCase(),
      action,
      label: clean(f.getAttribute("aria-label") || submit?.textContent || (submit as HTMLInputElement | null)?.value, 60),
      hidden: inputs.filter((i) => typeOf(i) === "hidden" && i.name).map((i) => i.name).slice(0, 20),
      fields: inputs.filter((i) => i.name).map((i) => ({ name: i.name, type: typeOf(i) })).slice(0, 40),
      password: inputs.some((i) => typeOf(i) === "password"),
    });
  }

  const metaCsrf = doc.querySelector('meta[name="csrf-token"], meta[name="_csrf"], meta[name="x-csrf-token"], meta[name="csrf-param"]') !== null;

  const mixed: string[] = [];
  if (pageUrl.startsWith("https:")) {
    const seen = new Set<string>();
    for (const el of Array.from(doc.querySelectorAll("script[src], link[rel~=stylesheet][href], img[src], iframe[src], source[src], audio[src], video[src]"))) {
      const url = el.getAttribute("src") || el.getAttribute("href") || "";
      if (url.toLowerCase().startsWith("http:") && !seen.has(url)) {
        seen.add(url);
        mixed.push(url.slice(0, 200));
      }
    }
  }

  const body = doc.body;
  const raw = (body as HTMLElement | null)?.innerText ?? body?.textContent ?? "";
  const text = [doc.title, raw].filter(Boolean).join("\n").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 20_000);
  return { forms, metaCsrf, mixed: mixed.slice(0, 5), text };
}
