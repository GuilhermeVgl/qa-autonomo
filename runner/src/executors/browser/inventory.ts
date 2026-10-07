import type { Inventory } from "../../agent/interaction.js";

/**
 * Reads the forms and buttons of a page (or of one part of it, like a modal) and tags each element with a
 * `data-qa-ref` so the browser can find it again. Self-contained on purpose: Playwright serializes it into the page
 * via `page.evaluate`, and the tests run it under jsdom with `assumeVisible` (jsdom has no layout).
 */
export function collectInventory(root: Document | Element, assumeVisible: boolean): Inventory {
  const doc = root.ownerDocument ?? (root as Document);
  const scope: ParentNode = root;
  for (const el of Array.from(doc.querySelectorAll("[data-qa-ref]"))) el.removeAttribute("data-qa-ref");

  const clean = (s: string | null | undefined, max: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (el: Element): boolean => {
    if (assumeVisible) return true;
    const style = doc.defaultView?.getComputedStyle(el);
    return el.getClientRects().length > 0 && style?.visibility !== "hidden";
  };
  const labelOf = (el: Element): string => {
    const input = el as HTMLInputElement;
    const fromLabel = input.labels && input.labels.length > 0 ? clean(input.labels[0]?.textContent, 80) : "";
    return fromLabel || clean(el.getAttribute("aria-label"), 80) || clean(el.getAttribute("placeholder"), 80) || clean(el.getAttribute("name"), 80);
  };
  const textOf = (el: Element): string =>
    clean(el.getAttribute("aria-label"), 80) || clean(el.textContent, 80) || clean(el.getAttribute("value"), 80) || clean(el.getAttribute("title"), 80);

  let nForm = 0;
  let nField = 0;
  let nButton = 0;
  const tag = (el: Element, ref: string): string => {
    el.setAttribute("data-qa-ref", ref);
    return ref;
  };
  const submitters = new Set<Element>();

  const forms: Inventory["forms"] = [];
  for (const form of Array.from(scope.querySelectorAll("form")).filter(visible).slice(0, 12)) {
    const formEl = form as HTMLFormElement;
    const ref = tag(form, `f${nForm++}`);
    const override = (form.querySelector('input[type="hidden"][name="_method"]') as HTMLInputElement | null)?.value?.toUpperCase();
    const declared = (form.getAttribute("method") ?? "get").toUpperCase();
    const method = override === "PUT" || override === "PATCH" || override === "DELETE" ? override : declared;
    let action = "/";
    try {
      action = new URL(formEl.getAttribute("action") || doc.location?.pathname || "/", doc.location?.href ?? "http://localhost/").pathname;
    } catch {
      action = formEl.getAttribute("action") ?? "/";
    }

    const fields: Inventory["forms"][number]["fields"] = [];
    const radios = new Set<string>();
    for (const el of Array.from(form.querySelectorAll("input, select, textarea"))) {
      if (fields.length >= 30) break;
      const input = el as HTMLInputElement & HTMLSelectElement;
      const type = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : (input.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset"].includes(type) || !visible(el)) continue;
      if (type === "radio") {
        if (radios.has(input.name)) continue; // one radio per group is enough to choose
        radios.add(input.name);
      }
      const options =
        type === "select"
          ? Array.from(input.options)
              .filter((o) => o.value !== "" && !o.disabled)
              .map((o) => o.value)
              .slice(0, 20)
          : [];
      fields.push({
        ref: tag(el, `i${nField++}`),
        name: input.name ?? "",
        type,
        label: labelOf(el),
        required: input.required === true,
        placeholder: clean(el.getAttribute("placeholder"), 80),
        options,
        maxlength: input.maxLength > 0 ? input.maxLength : undefined,
        min: el.getAttribute("min") ?? undefined,
        max: el.getAttribute("max") ?? undefined,
      });
    }

    const submit = Array.from(form.querySelectorAll('button, input[type="submit"]')).find(
      (b) => (b.getAttribute("type") ?? (b.tagName === "BUTTON" ? "submit" : "")).toLowerCase() === "submit" && visible(b),
    );
    let submitRef: string | null = null;
    if (submit) {
      submitRef = tag(submit, `b${nButton++}`);
      submitters.add(submit);
    }
    for (const other of Array.from(form.querySelectorAll('button:not([type="button"]), input[type="submit"]'))) submitters.add(other);
    const heading = form.querySelector("legend, h1, h2, h3, h4");
    forms.push({
      ref,
      method,
      action,
      label: clean(form.getAttribute("aria-label"), 80) || clean(heading?.textContent, 80),
      fields,
      submitRef,
      submitLabel: submit ? textOf(submit) : "",
      hasFile: fields.some((f) => f.type === "file"),
      hasPassword: fields.some((f) => f.type === "password"),
    });
  }

  const buttons: Inventory["buttons"] = [];
  for (const el of Array.from(scope.querySelectorAll('button, [role="button"], [role="tab"], summary, input[type="button"]'))) {
    if (buttons.length >= 40) break;
    if (submitters.has(el) || !visible(el)) continue;
    const label = textOf(el);
    if (!label) continue;
    const role = el.getAttribute("role");
    buttons.push({
      ref: tag(el, `b${nButton++}`),
      label,
      kind: el.tagName === "SUMMARY" ? "summary" : role === "tab" ? "tab" : el.hasAttribute("aria-expanded") ? "toggle" : "button",
      disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true",
    });
  }

  const headings = Array.from(scope.querySelectorAll("h1, h2, h3"))
    .filter(visible)
    .map((h) => clean(h.textContent, 80))
    .filter(Boolean)
    .slice(0, 5);
  return { title: clean(doc.title, 120), headings, forms, buttons };
}
