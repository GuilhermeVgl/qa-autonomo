import { nodeFingerprint } from "../fingerprint/fingerprint.js";
import { heuristicUnderstanding } from "./analyst.js";
import { factsFrom, pageActions, type Facts } from "./facts.js";
import type { DestructivePolicy } from "./guards.js";
import type { ActionResult, ActionSpec, Intent, Inventory, Outcome, Understanding } from "./interaction.js";
import { probePage, type ProbeResult } from "./probe.js";
import type { EventSink } from "./sink.js";

export interface Analyst {
  understand(route: string, inventory: Inventory): Promise<Understanding>;
}

/** A browser session that can look at forms and buttons and act on them. */
export interface InteractiveSession {
  visit(url: string): Promise<unknown>;
  inventory(): Promise<Inventory>;
  perform(action: ActionSpec): Promise<ActionResult>;
}

/** State of the interactive part of the exploration of one user: each user has their own budget and their own record of what was found. */
export interface InteractiveState {
  /** Browser actions this user may still spend (`budget.max_actions` is per user, so every user is explored as deeply). */
  actionsLeft: number;
  analyst?: Analyst | undefined;
  /** Test data is unique per submission within the run. */
  seed: number;
  emittedNodes: Set<string>;
  emittedEdges: Set<string>;
  /** Signatures of global-chrome actions (header/sidebar) already tried this user, so they are not re-tried on every page. */
  chromeSeen: Set<string>;
  totals: {
    pages_examined: number;
    actions: number;
    forms_submitted: number;
    endpoints_observed: number;
    modals_found: number;
    writes_blocked: number;
    skipped_never: number;
    skipped_sensitive: number;
    skipped_risky: number;
    skipped_chrome: number;
  };
}

export const PER_PAGE_ACTIONS = 14;

export function newInteractiveState(maxActions: number, analyst?: Analyst, seed = 0): InteractiveState {
  return {
    actionsLeft: maxActions,
    analyst,
    seed,
    emittedNodes: new Set(),
    emittedEdges: new Set(),
    chromeSeen: new Set(),
    totals: { pages_examined: 0, actions: 0, forms_submitted: 0, endpoints_observed: 0, modals_found: 0, writes_blocked: 0, skipped_never: 0, skipped_sensitive: 0, skipped_risky: 0, skipped_chrome: 0 },
  };
}

/** The sum of what the explorations of several users did. */
export function addTotals(into: InteractiveState["totals"], from: InteractiveState["totals"]): void {
  for (const k of Object.keys(into) as (keyof InteractiveState["totals"])[]) into[k] += from[k];
}

export function zeroTotals(): InteractiveState["totals"] {
  return newInteractiveState(0).totals;
}

export interface Examination {
  /** Goes into the page node's metadata: what the page is, what can be done on it, what happened when it was tried. */
  metadata: Record<string, unknown>;
  facts: Facts;
  outcomes: Outcome[];
}

const visibleFields = (f: Inventory["forms"][number]) => f.fields.filter((x) => !["hidden", "submit", "button"].includes(x.type));

/** Reads the page (forms, buttons), understands it and, while the run has actions left, tries what is safe to try. */
export async function examinePage(
  session: InteractiveSession,
  pageUrl: string,
  route: string,
  state: InteractiveState,
  env: { policy: DestructivePolicy; deadline: number; shouldStop: () => boolean },
): Promise<Examination> {
  const inventory = await session.inventory();
  const understanding = state.analyst ? await state.analyst.understand(route, inventory) : heuristicUnderstanding(route, inventory);

  let probe: ProbeResult = { outcomes: [], skipped: { never: 0, sensitive: 0, risky: 0, chrome: 0 }, used: 0 };
  if (state.actionsLeft > 0) {
    probe = await probePage({
      session,
      pageUrl,
      inventory,
      policy: env.policy,
      maxActions: Math.min(PER_PAGE_ACTIONS, state.actionsLeft),
      understanding,
      seed: () => ++state.seed,
      chromeSeen: state.chromeSeen,
      shouldStop: env.shouldStop,
      deadline: env.deadline,
    });
    state.actionsLeft -= probe.used;
  }
  const facts = factsFrom(probe.outcomes);

  const t = state.totals;
  t.pages_examined++;
  t.actions += probe.used;
  t.forms_submitted += probe.outcomes.filter((o) => o.kind === "submit-valid").length;
  t.writes_blocked += facts.endpoints.filter((e) => e.blocked).length;
  t.skipped_never += probe.skipped.never;
  t.skipped_sensitive += probe.skipped.sensitive;
  t.skipped_risky += probe.skipped.risky;
  t.skipped_chrome += probe.skipped.chrome;

  const led = followedOf(facts.navigations);
  const metadata: Record<string, unknown> = {
    title: inventory.title.slice(0, 120),
    headings: inventory.headings.slice(0, 5),
    summary: understanding.summary,
    controls: inventory.buttons.slice(0, 20).map((b) => ({
      label: b.label.slice(0, 60),
      intent: understanding.buttons[b.ref]?.intent ?? "other",
      what: understanding.buttons[b.ref]?.description ?? "",
    })),
    forms: inventory.forms.slice(0, 8).map((f) => ({
      label: (f.label || f.submitLabel).slice(0, 60),
      method: f.method,
      action: f.action,
      purpose: understanding.forms[f.ref]?.purpose ?? "",
      fields: visibleFields(f)
        .slice(0, 15)
        .map((x) => ({ name: x.name, label: x.label.slice(0, 40), type: x.type, required: x.required })),
    })),
    actions: pageActions(probe.outcomes),
  };
  // where the actions led is remembered, so continuing an interrupted exploration can follow it without acting again
  if (led.length) metadata["followed"] = led.slice(0, MAX_FOLLOWED).map((f) => ({ url: f.url.slice(0, 500), label: f.label, type: f.action.type, intent: f.action.intent }));
  if (facts.messages.length) metadata["messages"] = facts.messages;
  if (facts.dialogs.length) metadata["dialogs"] = facts.dialogs;
  return { metadata, facts, outcomes: probe.outcomes };
}

/** A place the actions led to, to be followed like a link. */
export interface Followed {
  url: string;
  label: string;
  action: { type: "submit" | "search" | "click"; intent: Intent };
}

/** How many places per screen are remembered for a continuation. */
const MAX_FOLLOWED = 10;

function followedOf(navigations: Facts["navigations"]): Followed[] {
  return navigations.map((n) => ({
    url: n.url,
    label: n.label,
    action: { type: n.kind === "search" ? "search" : n.kind === "click" ? "click" : "submit", intent: n.intent },
  }));
}

/**
 * Puts what the page examination found on the map: the endpoints behind its forms and buttons (one node per verb
 * and path), the modals it opens, and where submitting led. The page node itself must already have been sent.
 */
export function emitExamination(sink: EventSink, state: InteractiveState, at: { pageFp: string; pageUrl: string; route: string; role: string }, exam: Examination): Followed[] {
  const edge = (to: string, key: string, action: Record<string, unknown>): void => {
    const id = `${at.pageFp}|${to}|${key}`;
    if (state.emittedEdges.has(id)) return;
    state.emittedEdges.add(id);
    sink.edge({ key, from_fingerprint: at.pageFp, to_fingerprint: to, action, app_role: at.role });
  };

  for (const e of exam.facts.endpoints) {
    if (!state.emittedNodes.has(e.fingerprint)) {
      state.emittedNodes.add(e.fingerprint);
      state.totals.endpoints_observed++;
      sink.node({
        fingerprint: e.fingerprint,
        kind: "endpoint",
        label: e.fingerprint,
        app_role: at.role,
        metadata: { source: "observed", observed: { statuses: e.statuses, blocked: e.blocked, fields: e.fields.slice(0, 20), triggers: e.triggers.slice(0, 5), seen_on: at.route } },
      });
    }
    const trigger = e.triggers[0];
    edge(e.fingerprint, `call ${e.fingerprint}`, {
      type: "request",
      method: e.method,
      path: e.path,
      trigger: trigger?.label ?? "",
      intent: trigger?.intent ?? "other",
      statuses: e.statuses,
      blocked: e.blocked,
    });
  }

  for (const m of exam.facts.modals) {
    const fp = nodeFingerprint({ url: at.pageUrl, domSignature: m.signature, appRole: at.role });
    if (!state.emittedNodes.has(fp)) {
      state.emittedNodes.add(fp);
      state.totals.modals_found++;
      const label = `${at.route} › ${m.label}`.slice(0, 200);
      sink.node({ fingerprint: fp, kind: "modal", label, app_role: at.role, metadata: { opened_by: m.label, summary: heuristicUnderstanding(label, m.inventory).summary } });
    }
    edge(fp, `open ${m.label}`.slice(0, 200), { type: "click", label: m.label, intent: "open" });
  }

  return followedOf(exam.facts.navigations);
}
