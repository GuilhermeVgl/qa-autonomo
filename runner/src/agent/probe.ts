import { classifyIntent, fakeValue, needsAllow } from "./controls.js";
import type { DestructivePolicy } from "./guards.js";
import type { ActionResult, ActionSpec, ButtonInfo, FormInfo, Intent, Inventory, Outcome, Understanding } from "./interaction.js";

/** The part of a browser session the probe needs. */
export interface ProbeSession {
  visit(url: string): Promise<unknown>;
  inventory(): Promise<Inventory>;
  perform(action: ActionSpec): Promise<ActionResult>;
}

export interface ProbeInput {
  session: ProbeSession;
  pageUrl: string;
  /** Inventory of the page as it is right now (already loaded in the session). */
  inventory: Inventory;
  policy: DestructivePolicy;
  /** How many browser actions this page may use. */
  maxActions: number;
  understanding?: Understanding | null | undefined;
  /** A number that makes the test data of each submission unique. */
  seed: () => number;
  shouldStop: () => boolean;
  deadline: number;
}

export interface ProbeResult {
  outcomes: Outcome[];
  /** Controls left alone: logout/account removal, forms with passwords, risky buttons in an environment that does not allow them. */
  skipped: { never: number; sensitive: number; risky: number };
  /** Browser actions used (opening a modal again counts). */
  used: number;
}

interface Planned {
  kind: Outcome["kind"];
  label: string;
  intent: Intent;
  /** Lower goes first: buttons, then searches, then ordinary forms, then risky ones. */
  order: number;
  via?: string;
  form?: { action: string; method: string };
  build: (inv: Inventory) => ActionSpec | null;
}

const ORDER = { button: 0, search: 1, form: 2, risky: 3 } as const;

/**
 * Works a page like a person would: opens what opens, searches, tries each form empty (validation) and then with
 * plausible data, and watches what happens. Every action starts from a freshly loaded page. What can hurt is held
 * back: logout and account removal never run; deleting and external effects (WhatsApp, payments) only in an
 * environment that allows it, last; and when it does not, risky forms are still tried, because the browser session
 * aborts every write request before it leaves the machine, which is how the endpoint behind them is learned.
 */
export async function probePage(input: ProbeInput): Promise<ProbeResult> {
  const skipped = { never: 0, sensitive: 0, risky: 0 };
  const outcomes: Outcome[] = [];
  const queue: Planned[] = plan(input.inventory, input, skipped);
  let used = 0;
  let loaded = true; // the page is fresh in the session until the first action runs

  const exhausted = () => input.shouldStop() || Date.now() >= input.deadline || used >= input.maxActions;

  while (queue.length > 0 && !exhausted()) {
    queue.sort((a, b) => a.order - b.order);
    const next = queue.shift() as Planned;

    let inv = input.inventory;
    if (!loaded) {
      await input.session.visit(input.pageUrl);
      inv = await input.session.inventory();
    }
    loaded = false;

    if (next.via) {
      // inside a modal: open it again first
      const opener = locateButton(inv, next.via);
      if (!opener || exhausted()) continue;
      used++;
      await safePerform(input.session, { type: "click", ref: opener.ref, label: next.via });
      inv = await input.session.inventory();
    }
    const action = next.build(inv);
    if (!action) continue;

    used++;
    const result = await safePerform(input.session, action);
    outcomes.push({ action, kind: next.kind, intent: next.intent, label: next.label, via: next.via, form: next.form, result });

    // a modal opened by a plain click: its forms and buttons are worth a visit of their own (one level deep)
    if (!next.via && next.kind === "click" && result.modal) {
      for (const p of plan(result.modal.inventory, input, skipped, next.label)) queue.push({ ...p, order: p.order + 0.5 });
    }
  }
  return { outcomes, skipped, used };
}

async function safePerform(session: ProbeSession, action: ActionSpec): Promise<ActionResult> {
  try {
    return await session.perform(action);
  } catch (err) {
    return { requests: [], navigatedTo: null, status: null, modal: null, messages: [`erro: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`], dialog: null };
  }
}

function plan(inv: Inventory, input: ProbeInput, skipped: ProbeResult["skipped"], via?: string): Planned[] {
  const out: Planned[] = [];
  const allow = input.policy === "allow";
  const understanding = input.understanding;

  const seenButtons = new Map<string, number>();
  for (const b of inv.buttons) {
    if (b.disabled) continue;
    const intent = understanding?.buttons[b.ref]?.intent ?? classifyIntent(b.label);
    if (intent === "never") {
      skipped.never++;
      continue;
    }
    if (needsAllow(intent) && !allow) {
      skipped.risky++; // a script behind a button is not covered by the write guard of forms, so it is not tried
      continue;
    }
    const nth = seenButtons.get(b.label) ?? 0;
    seenButtons.set(b.label, nth + 1);
    out.push({
      kind: "click",
      label: b.label,
      intent,
      order: needsAllow(intent) ? ORDER.risky : ORDER.button,
      ...(via ? { via } : {}),
      build: (cur) => {
        const found = locateButton(cur, b.label, nth, b.kind);
        return found ? { type: "click", ref: found.ref, label: b.label, accept: needsAllow(intent) } : null;
      },
    });
  }

  const seenForms = new Map<string, number>();
  for (const f of inv.forms) {
    const key = formKey(f);
    const nth = seenForms.get(key) ?? 0;
    seenForms.set(key, nth + 1);
    const label = f.submitLabel || f.label || "Enviar";
    if (f.hasPassword) {
      skipped.sensitive++;
      continue;
    }
    const intent = classifyIntent(label);
    if (intent === "never") {
      skipped.never++;
      continue;
    }
    const meta = { form: { action: f.action, method: f.method }, ...(via ? { via } : {}) };
    const valuesFor = (): Record<string, string | boolean> => {
      const values: Record<string, string | boolean> = {};
      const n = input.seed();
      f.fields.forEach((field) => {
        const proposed = understanding?.forms[f.ref]?.values[field.ref];
        const v = proposed ?? fakeValue(field, n);
        if (v !== null && v !== undefined) values[field.ref] = v;
      });
      return values;
    };
    const filled = valuesFor();
    // values are kept by position, so they can be applied to the same form after a reload
    const byIndex = f.fields.map((field) => filled[field.ref]);
    const build = (empty: boolean, accept: boolean) => (cur: Inventory): ActionSpec | null => {
      const form = locateForm(cur, f, nth);
      if (!form) return null;
      const values: Record<string, string | boolean> = {};
      if (!empty) form.fields.forEach((field, i) => byIndex[i] !== undefined && (values[field.ref] = byIndex[i] as string | boolean));
      return { type: "submit", formRef: form.ref, values, submitRef: form.submitRef, accept };
    };

    if (f.method === "GET") {
      out.push({ kind: "search", label, intent: intent === "filter" ? "filter" : "search", order: ORDER.search, ...meta, build: build(false, false) });
      continue;
    }
    if (needsAllow(intent)) {
      // risky write: with `allow` it runs for real (last); otherwise the session's write guard stops it on the wire
      out.push({ kind: "submit-valid", label, intent, order: ORDER.risky, ...meta, build: build(false, true) });
      continue;
    }
    if (f.hasFile && f.fields.some((x) => x.type === "file" && x.required)) continue; // cannot satisfy an upload
    if (f.fields.some((x) => x.required && x.type !== "hidden")) out.push({ kind: "submit-empty", label, intent, order: ORDER.form, ...meta, build: build(true, false) });
    out.push({ kind: "submit-valid", label, intent, order: ORDER.form, ...meta, build: build(false, false) });
  }
  return out;
}

const formKey = (f: FormInfo): string => `${f.method} ${f.action} ${f.label} ${f.submitLabel}`;

function locateButton(inv: Inventory, label: string, nth = 0, kind?: ButtonInfo["kind"]): ButtonInfo | undefined {
  return inv.buttons.filter((b) => b.label === label && (kind === undefined || b.kind === kind))[nth];
}

function locateForm(inv: Inventory, like: FormInfo, nth: number): FormInfo | undefined {
  return inv.forms.filter((f) => formKey(f) === formKey(like))[nth];
}
