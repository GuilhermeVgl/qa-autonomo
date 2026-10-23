import { classifyIntent, fakeValue, isOwnAccountForm, needsAllow } from "./controls.js";
import type { Session } from "./explorer.js";
import type { DestructivePolicy } from "./guards.js";
import type { ActionResult, ObservedRequest } from "./interaction.js";

/**
 * A form named by a requirement of a generated spec: `FORM POST /clients` (fill it in and send it) or
 * `VALIDATE POST /clients` (send it empty and see that it refuses).
 */
export interface FormRef {
  key: string;
  method: string;
  action: string;
  mode: "submit" | "validate";
}

const FORM_KEY = /^(FORM|VALIDATE) (GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;

export function formRefsOf(keys: string[]): FormRef[] {
  const out: FormRef[] = [];
  for (const key of keys) {
    const m = FORM_KEY.exec(key.trim());
    if (m && !out.some((f) => f.key === key.trim())) out.push({ key: key.trim(), mode: m[1] === "VALIDATE" ? "validate" : "submit", method: m[2] as string, action: m[3] as string });
  }
  return out;
}

/** Fields that may carry secrets: their value is never written into evidence (the server masks the same way). */
const SENSITIVE = /pass|senha|secret|token|cookie|authorization|api[_-]?key/i;

export interface FormInput {
  field: string;
  label: string;
  type: string;
  value: string;
}

export interface FormVerdict {
  result: "pass" | "fail" | "error" | "skipped";
  actual: string;
  /** What goes into the `http` evidence of the step. */
  evidence: Record<string, unknown>;
  inputs: FormInput[];
}

const verdict = (ref: FormRef, pageUrl: string, policy: DestructivePolicy, result: FormVerdict["result"], actual: string, extra: Partial<Record<string, unknown>> = {}, inputs: FormInput[] = []): FormVerdict => ({
  result,
  actual,
  inputs,
  evidence: { kind: "form", url: pageUrl, form: { method: ref.method, action: ref.action }, policy, inputs, result, actual, ...extra },
});

/**
 * Tries a form of the page the way the spec says it should work: fills it with test data, submits and judges what the
 * server answered. In an environment that does not allow writing the browser session stops the request before it
 * leaves (the step is then skipped, with what would have been sent kept as evidence); risky forms (delete, send
 * something out) only run where the environment allows it.
 */
export async function checkForm(session: Session, pageUrl: string, ref: FormRef, policy: DestructivePolicy, seed: number): Promise<FormVerdict> {
  if (!session.inventory || !session.perform) return verdict(ref, pageUrl, policy, "skipped", "a sessão não consegue interagir com a página");
  if (ref.mode === "validate") return checkValidation(session, pageUrl, ref, policy);
  try {
    await session.visit(pageUrl);
    const inv = await session.inventory();
    const form = inv.forms.find((f) => f.method === ref.method && f.action === ref.action);
    if (!form) return verdict(ref, pageUrl, policy, "fail", `o formulário ${ref.method} ${ref.action} não está mais na tela`);
    if (isOwnAccountForm(form)) {
      return verdict(ref, pageUrl, policy, "skipped", `"${form.submitLabel || form.label || ref.key}" parece alterar o próprio usuário logado; esse tipo de alteração nunca é executado`);
    }

    const label = form.submitLabel || form.label;
    const intent = classifyIntent(label);
    if (intent === "never") return verdict(ref, pageUrl, policy, "skipped", `"${label}" encerra a sessão ou a conta e nunca é acionado`);
    if (needsAllow(intent) && policy !== "allow") {
      return verdict(ref, pageUrl, policy, "skipped", `"${label}" apaga dados ou dispara algo fora do app; só roda em ambiente que permite (política: ${policy})`);
    }

    const values: Record<string, string | boolean> = {};
    const inputs: FormInput[] = [];
    for (const f of form.fields) {
      const v = fakeValue(f, seed);
      if (v === null) continue;
      values[f.ref] = v;
      inputs.push({ field: f.name, label: f.label, type: f.type, value: SENSITIVE.test(`${f.name} ${f.label}`) ? "***" : String(v) });
    }
    const result = await session.perform({ type: "submit", formRef: form.ref, values, submitRef: form.submitRef, accept: needsAllow(intent) && policy === "allow" });
    return judge(ref, pageUrl, policy, form.method, result, inputs);
  } catch (err) {
    return verdict(ref, pageUrl, policy, "error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * What a form must refuse is as much its behavior as what it accepts: submit it with nothing typed and see that it does
 * not go through and that the person is told what is missing. A page that stops the send itself (a required field) and
 * says why passes; a server that refuses (4xx) or shows the form again with messages passes; a server that accepts the
 * empty data fails. Where the environment does not allow writing and the page tries to send, the server's answer cannot
 * be seen, so the step is skipped.
 */
async function checkValidation(session: Session, pageUrl: string, ref: FormRef, policy: DestructivePolicy): Promise<FormVerdict> {
  try {
    await session.visit(pageUrl);
    const inv = await (session.inventory as NonNullable<Session["inventory"]>)();
    const form = inv.forms.find((f) => f.method === ref.method && f.action === ref.action);
    const gone = verdict(ref, pageUrl, policy, "fail", `o formulário ${ref.method} ${ref.action} não está mais na tela`, { mode: "validate" });
    if (!form) return gone;
    if (isOwnAccountForm(form)) {
      return verdict(ref, pageUrl, policy, "skipped", `"${form.submitLabel || form.label || ref.key}" parece alterar o próprio usuário logado; esse tipo de validação nunca é executado`, { mode: "validate" });
    }
    const label = form.submitLabel || form.label;
    if (classifyIntent(label) === "never") return verdict(ref, pageUrl, policy, "skipped", `"${label}" encerra a sessão ou a conta e nunca é acionado`, { mode: "validate" });

    const required = form.fields.filter((f) => f.required && !["hidden", "submit", "button"].includes(f.type)).map((f) => f.name);
    const res = await (session.perform as NonNullable<Session["perform"]>)({ type: "submit", formRef: form.ref, values: {}, submitRef: form.submitRef });
    const extra = { mode: "validate", required, requests: res.requests, final_url: res.navigatedTo ?? pageUrl, status: res.status, messages: res.messages, dialog: res.dialog };
    const done = (r: FormVerdict["result"], actual: string) => verdict(ref, pageUrl, policy, r, actual, extra, []);

    const writes = res.requests.filter(isWrite);
    const said = res.messages[0];
    if (writes.some((r) => r.blocked)) {
      return done("skipped", `o ambiente não permite escrever (política: ${policy}): a tela tentou enviar o formulário vazio e a requisição foi parada; não dá para saber se o servidor valida`);
    }
    if (writes.length === 0) {
      return said ? done("pass", `o formulário não foi enviado e a tela mostrou o que falta: "${said.slice(0, 120)}"`) : done("fail", "o formulário vazio não foi enviado e a tela não mostrou o que falta");
    }
    const refused = writes.find((r) => (r.status ?? 0) >= 400);
    if (refused) return done("pass", `o servidor recusou o envio vazio: ${show(refused)} → ${refused.status}`);
    if (said) return done("pass", `o servidor devolveu o formulário com o que falta: "${said.slice(0, 120)}"`);
    const first = writes[0] as ObservedRequest;
    return done("fail", `aceitou o envio vazio: ${show(first)} → ${first.status ?? "?"}${res.navigatedTo ? ` → ${new URL(res.navigatedTo).pathname}` : ""}`);
  } catch (err) {
    return verdict(ref, pageUrl, policy, "error", err instanceof Error ? err.message : String(err), { mode: "validate" });
  }
}

const isWrite = (r: ObservedRequest) => r.method !== "GET" && r.method !== "HEAD" && r.method !== "OPTIONS";
const show = (r: ObservedRequest) => `${r.method} ${r.path}`;

function judge(ref: FormRef, pageUrl: string, policy: DestructivePolicy, method: string, res: ActionResult, inputs: FormInput[]): FormVerdict {
  const extra = { requests: res.requests, final_url: res.navigatedTo ?? pageUrl, status: res.status, messages: res.messages, dialog: res.dialog };
  const done = (r: FormVerdict["result"], actual: string) => verdict(ref, pageUrl, policy, r, actual, extra, inputs);

  if (method === "GET") {
    const bad = res.requests.find((r) => (r.status ?? 0) >= 400);
    if (bad) return done("fail", `HTTP ${bad.status} em ${show(bad)}`);
    if (!res.navigatedTo && res.requests.length === 0) return done("fail", `a busca não levou a lugar nenhum${res.messages[0] ? `: ${res.messages[0]}` : ""}`);
    return done("pass", `GET ${ref.action} → ${res.status ?? 200}`);
  }

  const writes = res.requests.filter(isWrite);
  const held = writes.filter((r) => r.blocked);
  if (held.length > 0) {
    return done("skipped", `o ambiente não permite escrever (política: ${policy}): ${held.map(show).join(", ")} não foi enviado (campos: ${[...new Set(held.flatMap((r) => r.fields))].join(", ") || "nenhum"})`);
  }
  if (writes.length === 0) return done("fail", `o formulário não foi enviado${res.messages[0] ? `: ${res.messages[0]}` : ""}`);
  const bad = writes.find((r) => (r.status ?? 0) >= 400) ?? (res.status !== null && res.status >= 400 ? { ...(writes[0] as ObservedRequest), status: res.status } : undefined);
  if (bad) return done("fail", `HTTP ${bad.status} em ${show(bad)}`);
  const first = writes[0] as ObservedRequest;
  return done("pass", `${show(first)} → ${first.status ?? "?"}${res.navigatedTo ? ` → ${new URL(res.navigatedTo).pathname}` : ""}`);
}
