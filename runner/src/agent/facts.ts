import { endpointPath } from "./controls.js";
import type { Intent, Inventory, Outcome } from "./interaction.js";

export interface EndpointFact {
  /** `METHOD /path/{id}`, the same notation the specs use. */
  fingerprint: string;
  method: string;
  path: string;
  statuses: number[];
  /** The call was stopped before reaching the server (the environment does not allow writes). */
  blocked: boolean;
  fields: string[];
  triggers: { label: string; intent: Intent }[];
}

export interface Facts {
  endpoints: EndpointFact[];
  modals: { label: string; signature: string; inventory: Inventory }[];
  navigations: { url: string; label: string; intent: Intent; kind: Outcome["kind"] }[];
  messages: string[];
  dialogs: string[];
}

const MAX_REVEALED = 30;
const unique = <T>(list: T[], max: number): T[] => [...new Set(list)].slice(0, max);

/** Turns what the probe saw into things the map can hold. */
export function factsFrom(outcomes: Outcome[]): Facts {
  const endpoints = new Map<string, EndpointFact>();
  const modals: Facts["modals"] = [];
  const navigations: Facts["navigations"] = [];
  const messages: string[] = [];
  const dialogs: string[] = [];

  for (const o of outcomes) {
    for (const r of o.result.requests) {
      const method = r.method.toUpperCase();
      if (method === "HEAD" || method === "OPTIONS") continue;
      if (method === "GET" && r.resource === "document") continue; // a page load: the explorer follows it as a link
      const path = endpointPath(r.path);
      const fingerprint = `${method} ${path}`;
      const known = endpoints.get(fingerprint) ?? { fingerprint, method, path, statuses: [], blocked: false, fields: [], triggers: [] };
      if (r.status !== null && !known.statuses.includes(r.status)) known.statuses.push(r.status);
      known.blocked ||= r.blocked;
      for (const f of r.fields) if (!known.fields.includes(f)) known.fields.push(f);
      if (!known.triggers.some((t) => t.label === o.label)) known.triggers.push({ label: o.label, intent: o.intent });
      endpoints.set(fingerprint, known);
    }
    if (o.kind === "click" && !o.via && o.result.modal) modals.push({ label: o.label, signature: o.result.modal.signature, inventory: o.result.modal.inventory });
    if (o.result.navigatedTo) navigations.push({ url: o.result.navigatedTo, label: o.label, intent: o.intent, kind: o.kind });
    // what a click revealed is on the page now: the explorer follows it like any link, remembering what opened it
    for (const l of (o.result.links ?? []).slice(0, MAX_REVEALED)) navigations.push({ url: l.href, label: `${o.label} › ${l.label}`.slice(0, 120), intent: o.intent, kind: "click" });
    messages.push(...o.result.messages);
    if (o.result.dialog) dialogs.push(o.result.dialog);
  }
  const sorted = [...endpoints.values()].map((e) => ({ ...e, statuses: [...e.statuses].sort((a, b) => a - b) }));
  return { endpoints: sorted, modals, navigations, messages: unique(messages, 10), dialogs: unique(dialogs, 10) };
}

export interface ActionNote {
  kind: Outcome["kind"];
  label: string;
  intent: Intent;
  requests: string[];
  went_to?: string;
  messages?: string[];
  dialog?: string;
}

const MAX_NOTES = 25;

/** A short, bounded account of what was tried on a page, kept in the node's metadata. */
export function pageActions(outcomes: Outcome[]): ActionNote[] {
  return outcomes.slice(0, MAX_NOTES).map((o) => {
    const requests = o.result.requests
      .filter((r) => !(r.method === "GET" && r.resource === "document") && r.method !== "OPTIONS" && r.method !== "HEAD")
      .slice(0, 5)
      .map((r) => `${r.method} ${endpointPath(r.path)}${r.blocked ? " (bloqueada pela política)" : r.status !== null ? ` → ${r.status}` : ""}`);
    const note: ActionNote = { kind: o.kind, label: o.label.slice(0, 80), intent: o.intent, requests };
    if (o.result.navigatedTo) note.went_to = pathOf(o.result.navigatedTo);
    if (o.result.messages.length) note.messages = o.result.messages.slice(0, 3).map((m) => m.slice(0, 160));
    if (o.result.dialog) note.dialog = o.result.dialog.slice(0, 160);
    return note;
  });
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
