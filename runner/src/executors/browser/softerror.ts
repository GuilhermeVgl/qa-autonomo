/**
 * Tells whether a page that answered 200 is really an error screen ("Something went wrong", a styled 500 or 404), and
 * returns the text it shows. SPAs and friendly error pages never send an error status, so without this the map and the
 * tests would call them healthy. It is deliberately strict: a short main content, no field to fill, and an error phrase in the heading or
 * the first lines. A long page that merely mentions errors is not one.
 * Self-contained on purpose: Playwright serializes it into the page via `page.evaluate`.
 */
export function detectSoftError(doc: Document): string | null {
  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  // the content of the page, not the menu around it: real layouts carry a nav and a logout form on error screens too
  const main = doc.querySelector("main, [role=main]") ?? doc.body;
  const body = clean((main as HTMLElement | null)?.innerText ?? main?.textContent);
  const asksForInput = Array.from(main?.querySelectorAll("input, textarea, select") ?? []).some((el) => !["hidden", "submit", "button"].includes(((el as HTMLInputElement).type ?? "").toLowerCase()));
  if (body.length > 700 || asksForInput) return null;
  const heading = clean(doc.querySelector("h1, h2, [role=heading]")?.textContent) || clean(doc.title);
  const phrase =
    /internal server error|application error|something went wrong|unexpected error|an error occurred|erro interno|erro inesperado|ocorreu um erro|algo deu errado|não foi possível carregar|p[aá]gina n[aã]o encontrada|page not found|service unavailable|bad gateway|exception/i;
  const hay = `${clean(doc.title)} ${heading} ${body.slice(0, 300)}`;
  if (!phrase.test(hay) && !/(^|\s)(404|500|502|503)(\s|$).*(not found|error|erro|encontrad)/i.test(hay)) return null;
  return clean(`${heading} ${body}`.slice(0, 200)).slice(0, 200);
}
