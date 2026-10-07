/**
 * What the agent can see and do on a page besides following links: the forms and buttons of a screen (inventory),
 * the actions it performs on them and what it observed (requests with their real verb, new modals, navigation).
 */

export type Intent = "create" | "save" | "search" | "filter" | "edit" | "open" | "navigate" | "delete" | "external" | "toggle" | "never" | "other";

export interface FieldInfo {
  /** Stable handle for this inventory (`data-qa-ref` on the element). */
  ref: string;
  name: string;
  type: string; // input type, "select", "textarea"
  label: string;
  required: boolean;
  placeholder: string;
  options: string[]; // select options (non-empty values)
  maxlength?: number | undefined;
  min?: string | undefined;
  max?: string | undefined;
}

export interface FormInfo {
  ref: string;
  method: string; // uppercase, as declared (`_method` overrides are resolved on observed requests)
  action: string; // path only
  label: string;
  fields: FieldInfo[];
  submitRef: string | null;
  submitLabel: string;
  hasFile: boolean;
  hasPassword: boolean;
}

export interface ButtonInfo {
  ref: string;
  label: string;
  kind: "button" | "toggle" | "summary" | "tab";
  disabled: boolean;
}

export interface Inventory {
  title: string;
  headings: string[];
  forms: FormInfo[];
  /** Buttons that are not the submit button of a form. */
  buttons: ButtonInfo[];
}

export interface ObservedRequest {
  method: string; // effective verb (a Rails `_method=delete` form is reported as DELETE)
  path: string; // concrete path
  resource: "document" | "xhr" | "fetch";
  status: number | null; // null when it never reached the server
  /** Stopped by the scope/policy guard before reaching the server. */
  blocked: boolean;
  /** Names of the body fields, never their values. */
  fields: string[];
}

export type ActionSpec =
  | { type: "click"; ref: string; label: string; accept?: boolean }
  | { type: "submit"; formRef: string; values: Record<string, string | boolean>; submitRef: string | null; accept?: boolean };

export interface ActionResult {
  requests: ObservedRequest[];
  /** URL after the action, when the page navigated. */
  navigatedTo: string | null;
  status: number | null;
  /** A dialog (modal) is now visible that was not before; its structural signature and inventory. */
  modal: { signature: string; inventory: Inventory } | null;
  /** Texts the page showed to explain a problem (validation messages, alerts). */
  messages: string[];
  /** A native confirm/alert dialog appeared. */
  dialog: string | null;
  /** Links that appeared in the page without it navigating (a menu, a tab, an accordion opened by the action). */
  links?: { href: string; label: string }[];
}

/** What the agent learned from one action, ready to become graph facts. */
export interface Outcome {
  action: ActionSpec;
  kind: "click" | "submit-empty" | "submit-valid" | "search";
  intent: Intent;
  /** The button, or the form (its submit button / heading). */
  label: string;
  /** For actions inside a modal: the button that opened it. */
  via?: string | undefined;
  form?: { action: string; method: string } | undefined;
  result: ActionResult;
}

/** What the analyst (the LLM, when there is one) understood about a page; keyed by the refs of the inventory. */
export interface Understanding {
  summary: string;
  buttons: Record<string, { intent: Intent; description: string }>;
  forms: Record<string, { purpose: string; values: Record<string, string | boolean> }>;
}
