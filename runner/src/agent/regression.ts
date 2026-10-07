import { nodeFingerprint } from "../fingerprint/fingerprint.js";
import type { ArtifactRef, Job } from "../protocol/schemas.js";
import { firstLine, helpOf } from "./terminal.js";
import type { CommandRunner } from "../executors/terminal/exec.js";
import { callEndpoint, checkContract, type EndpointTarget } from "../executors/api/api.js";
import { appDownMessage, loginBlocked, type Blocked, type Credential, type Driver, type LoginFailureReason, type PageView, type Session } from "./explorer.js";
import { confirmDown, isInfraMessage } from "./health.js";
import { checkForm, formRefsOf, type FormRef, type FormVerdict } from "./formcheck.js";
import { isAllowedUrl, type DestructivePolicy } from "./guards.js";
import type { EventSink } from "./sink.js";
import { SecurityScan, newScanShare } from "../security/scan.js";
import type { Severity } from "../security/types.js";

type Target = NonNullable<Job["targets"]>[number];

/** Where evidence goes. Implemented by HttpUploader (object storage via the control plane). */
export interface Uploader {
  upload(kind: string, contentType: string, bytes: Uint8Array): Promise<ArtifactRef>;
}

export interface RegressionInput {
  driver: Driver;
  sink: EventSink;
  environment: { base_url: string; allowed_hosts: string[]; destructive_policy: DestructivePolicy; device?: string | undefined };
  credentials: Credential[];
  targets: Target[];
  uploader: Uploader;
  budget: Job["budget"];
  shouldStop: () => boolean;
  /** HTTP client for API targets (defaults to the global fetch); injectable for tests. */
  fetchFn?: typeof fetch;
  /** The CLI under test, for command targets (terminal environments). */
  command?: CommandRunner;
  /** Wait before the second try of a page that failed in a way that may be a hiccup (default 800 ms). */
  retryDelayMs?: number;
  /** Whether the application is down, asked only when a page failed in a way that could mean so. Defaults to asking it. */
  isDown?: (url: string) => Promise<{ down: boolean; detail: string }>;
}

export interface RegressionSummary {
  steps: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  login_failures: string[];
  /** Why each of those users could not get in. */
  login_failure_details: { role: string; reason: LoginFailureReason; message: string }[];
  /** What kept the run from its job (application down, nobody could log in): one problem to fix, not a bug per screen. */
  blocked?: Blocked;
  /** Screens left untested because their user could not get in: not failures, not bugs. */
  not_tested: number;
  /** Results per user: the run says who was tested for each scenario. Checks that belong to no user (API calls) count under "". */
  by_role: Record<string, { steps: number; passed: number; failed: number; errors: number; skipped: number }>;
  /** Security checks made along the way (they run unless the run turned them off). */
  security?: { checks: number; failed: number; by_severity: Record<Severity, number>; probes: number };
  stopped_by: "exhausted" | "max_seconds" | "cancelled" | "blocked";
}

/** More than this many browsers per user is more load than a test should put on an application. */
const MAX_CONCURRENCY = 6;

type Outcome = { result: "pass" | "fail" | "error" | "skipped"; actual: string; artifacts?: ArtifactRef[] };

/**
 * Regression: revisit each covered node and check it still answers (HTTP < 400) with the same structure
 * (fingerprint). Every step records input, expected, actual and result, plus a screenshot as evidence.
 */
export async function runRegression(input: RegressionInput): Promise<RegressionSummary> {
  const summary: RegressionSummary = { steps: 0, passed: 0, failed: 0, errors: 0, skipped: 0, login_failures: [], login_failure_details: [], not_tested: 0, by_role: {}, stopped_by: "exhausted" };
  const isDown = input.isDown ?? ((u: string) => confirmDown(u));
  const deadline = Date.now() + input.budget.max_seconds * 1000;
  const pages = input.targets.filter((t) => (t.kind ?? "page") === "page");
  const endpoints = input.targets.filter((t) => t.kind === "endpoint");
  const commands = input.targets.filter((t) => t.kind === "command");
  const roles = [...new Set(pages.map((t) => t.app_role))];

  // API targets need no browser session: plain HTTP with the environment's api_token, if any
  const token = input.credentials.find((c) => c.kind === "api_token")?.payload["token"];
  for (const t of endpoints) {
    if (input.shouldStop()) return finish(summary, "cancelled");
    if (Date.now() >= deadline) return finish(summary, "max_seconds");
    record(input, summary, t, await checkEndpoint(input, t, token));
  }

  for (const t of commands) {
    if (input.shouldStop()) return finish(summary, "cancelled");
    if (Date.now() >= deadline) return finish(summary, "max_seconds");
    record(input, summary, t, await checkCommand(input, t));
  }

  const concurrency = Math.max(1, Math.min(input.budget.concurrency ?? 1, MAX_CONCURRENCY));
  const share = newScanShare();
  if (!input.budget.no_security) summary.security = { checks: 0, failed: 0, by_severity: { critical: 0, high: 0, normal: 0 }, probes: 0 };
  for (const role of roles) {
    const mine = pages.filter((t) => t.app_role === role);
    const credential = input.credentials.find((c) => c.app_role === role);
    const first = await input.driver.newSession(role, credential);
    if (!first) {
      // not a failure of any screen: they were never reached. It is one problem, reported once, and creates no bugs
      const why = input.driver.loginFailure?.(role) ?? { reason: "rejected" as const, message: "o login não foi aceito" };
      summary.login_failures.push(role);
      summary.login_failure_details.push({ role, reason: why.reason, message: why.message });
      summary.not_tested += mine.length;
      if (why.reason === "unreachable") {
        const d = await isDown(input.environment.base_url);
        if (d.down) {
          summary.blocked = { kind: "app_down", message: appDownMessage(input.environment.base_url, d.detail) };
          return finish(summary, "blocked");
        }
      }
      continue;
    }
    // more browsers for the same user: each logs in on its own; one that cannot just means fewer, not a failure
    const sessions = [first];
    for (let i = 1; i < Math.min(concurrency, mine.length); i++) {
      const extra = await input.driver.newSession(role, credential).catch(() => null);
      if (!extra) break;
      sessions.push(extra);
    }
    const scan = input.budget.no_security
      ? undefined
      : new SecurityScan({ sink: input.sink, uploader: input.uploader, environment: input.environment, executor: input.environment.device ? "mobile_web" : "browser", role, share });
    let stop: RegressionSummary["stopped_by"] | undefined;
    let next = 0;
    const halted = (): boolean => {
      if (stop) return true;
      if (input.shouldStop()) stop = "cancelled";
      else if (Date.now() >= deadline) stop = "max_seconds";
      return stop !== undefined;
    };
    try {
      await Promise.all(
        sessions.map(async (session) => {
          for (let t = mine[next++]; t !== undefined && !halted(); t = mine[next++]) {
            const checked = await check(input, session, t, scan, isDown);
            if (checked.down) {
              // the application went away: this screen was not tested, and neither are the ones after it
              summary.blocked = { kind: "app_down", message: appDownMessage(input.environment.base_url, checked.down) };
              stop = "blocked";
              return;
            }
            const { outcome, view } = checked;
            record(input, summary, t, outcome);
            // the injections take the browser elsewhere, so they come after the evidence of the page is kept
            if (scan && view && view.status < 400) await scan.after(session, view, { id: t.node_id }, t.label, t.probes ?? []).catch(() => undefined);
            // the forms a generated spec names for this screen, each its own step with its own evidence
            for (const ref of formRefsOf(t.requirement_keys)) {
              if (halted()) return;
              await recordForm(input, summary, session, t, ref, outcome.result === "pass");
            }
          }
        }),
      );
    } finally {
      if (scan) await finishScan(scan, first, summary);
      await Promise.all(sessions.map((s) => s.close()));
    }
    if (stop) return finish(summary, stop);
  }
  if (!summary.blocked && summary.login_failure_details.length > 0) {
    summary.blocked = loginBlocked(summary.login_failure_details);
    if (summary.steps === 0) summary.stopped_by = "blocked"; // nobody got in: nothing was tested
  }
  return summary;
}

async function finishScan(scan: SecurityScan, session: Session, summary: RegressionSummary): Promise<void> {
  try {
    await scan.finish(session);
  } catch {
    // a security check that cannot be written down never costs a test
  }
  const s = scan.summary();
  const total = summary.security;
  if (!total) return;
  total.checks += s.checks;
  total.failed += s.failed;
  total.probes += s.probes;
  for (const k of Object.keys(s.by_severity) as Severity[]) total.by_severity[k] += s.by_severity[k];
}

function finish(summary: RegressionSummary, why: RegressionSummary["stopped_by"]): RegressionSummary {
  summary.stopped_by = why;
  return summary;
}

/** One try at a page, with what is needed to decide whether it is worth a second one. */
interface Attempt {
  outcome: Outcome;
  evidence: Record<string, unknown>;
  /** The failure may be a hiccup (server error, exception, structure caught half-rendered); a 4xx is an answer. */
  retriable: boolean;
  /** What the page showed, for the security checks that come after. */
  view?: PageView;
}

/**
 * Revisits a page. A failure that may be a hiccup gets a second try after a short wait: it avoids reporting a bug that
 * was a deploy, a cold cache or a half-rendered page. Passing on the second try is a pass that says it was flaky.
 */
async function check(
  input: RegressionInput,
  session: Session,
  t: Target,
  scan: SecurityScan | undefined,
  isDown: (url: string) => Promise<{ down: boolean; detail: string }>,
): Promise<{ outcome: Outcome; view?: PageView; down?: string }> {
  if (!t.url) return { outcome: { result: "error", actual: "page target without a url" } };
  if (!isAllowedUrl(t.url, input.environment.allowed_hosts)) return { outcome: { result: "skipped", actual: "target is outside the allowed hosts" } };
  const first = await attempt(input, session, t, scan);
  let last = first;
  const attempts = [first];
  if (first.outcome.result !== "pass" && first.retriable) {
    await sleepMs(input.retryDelayMs ?? 800);
    last = await attempt(input, session, t, scan);
    attempts.push(last);
  }
  // a screen that cannot load is that screen's problem, unless the whole application is gone: then nothing is reported for it
  const gateway = last.outcome.result === "fail" && /^HTTP 50[234]\b/.test(last.outcome.actual);
  if (last.outcome.result !== "pass" && (gateway || (last.outcome.result === "error" && isInfraMessage(last.outcome.actual)))) {
    const d = await isDown(input.environment.base_url);
    if (d.down) return { outcome: last.outcome, down: d.detail };
  }
  let outcome = last.outcome;
  const flaky = attempts.length === 2 && last.outcome.result === "pass";
  if (flaky) outcome = { ...outcome, actual: `${outcome.actual} (passou na 2ª tentativa; a 1ª: ${first.outcome.actual})` };
  else if (attempts.length === 2) outcome = { ...outcome, actual: `${outcome.actual} (falhou nas 2 tentativas)` };
  const evidence = { ...last.evidence, actual: outcome.actual, result: outcome.result, ...(attempts.length === 2 ? { flaky, attempts: attempts.map((a) => ({ result: a.outcome.result, actual: a.outcome.actual })) } : {}) };
  const artifacts = [await screenshot(input.uploader, session), await jsonEvidence(input.uploader, evidence)].filter((a): a is ArtifactRef => a !== null);
  return { outcome: artifacts.length > 0 ? { ...outcome, artifacts } : outcome, ...(last.view ? { view: last.view } : {}) };
}

const sleepMs = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

async function attempt(input: RegressionInput, session: Session, t: Target, scan: SecurityScan | undefined): Promise<Attempt> {
  const url = t.url as string;
  try {
    const view = await session.visit(url, scan ? { security: true } : undefined);
    scan?.page(view, { id: t.node_id }, t.label, session);
    const fp = nodeFingerprint({ url: view.url, domSignature: view.domSignature, appRole: t.app_role });
    let outcome: Outcome;
    let retriable = false;
    if (view.status >= 400) {
      outcome = { result: "fail", actual: `HTTP ${view.status}` };
      retriable = view.status >= 500;
    } else if (view.softError) {
      outcome = { result: "fail", actual: `HTTP ${view.status}, a tela mostra um erro: "${view.softError.slice(0, 160)}"` };
      retriable = true;
    } else if (fp !== t.fingerprint) {
      outcome = { result: "fail", actual: `HTTP ${view.status}, structure changed (fingerprint ${fp.slice(0, 8)} != ${t.fingerprint.slice(0, 8)})` };
      retriable = true;
    } else outcome = { result: "pass", actual: `HTTP ${view.status}, structure unchanged` };
    const evidence = {
      kind: "page",
      url,
      final_url: view.url,
      status: view.status,
      role: t.app_role,
      expected: pageExpected(t),
      structure: { expected: t.fingerprint, actual: fp, match: fp === t.fingerprint },
    };
    return { outcome, evidence, retriable, view };
  } catch (err) {
    const actual = err instanceof Error ? err.message : String(err);
    return { outcome: { result: "error", actual }, evidence: { kind: "page", url, role: t.app_role, expected: pageExpected(t) }, retriable: true };
  }
}

const pageExpected = (t: Target): string => `HTTP < 400 and same structure as when explored (${t.requirement_keys.join(", ") || "no requirement"})`;

/** Evidence of the inputs and what came back, as JSON; best effort like every evidence. */
async function jsonEvidence(uploader: Uploader, evidence: Record<string, unknown>): Promise<ArtifactRef | null> {
  try {
    return await uploader.upload("http", "application/json", new TextEncoder().encode(JSON.stringify(evidence)));
  } catch {
    return null;
  }
}

let formSeed = Math.floor(Date.now() / 1000) % 1_000_000;

/** One step per form of a spec: the data typed, the requests made and the answer, kept as evidence whatever the result. */
async function recordForm(input: RegressionInput, summary: RegressionSummary, session: Session, t: Target, ref: FormRef, pageOk: boolean): Promise<void> {
  const url = t.url ?? input.environment.base_url;
  const expected =
    ref.mode === "validate"
      ? `${ref.method} ${ref.action} recusa o envio sem os campos obrigatórios e mostra o que falta (${t.requirement_keys.join(", ")})`
      : `${ref.method} ${ref.action} aceita dados de teste e responde sem erro (${t.requirement_keys.join(", ")})`;
  const executor = input.environment.device ? "mobile_web" : "browser";
  const key = `${t.node_id}#${ref.key}`.slice(0, 190);

  let v: FormVerdict;
  let artifacts: ArtifactRef[] = [];
  if (!pageOk) {
    v = { result: "skipped", actual: "a tela do formulário não passou na checagem; o formulário não foi tentado", evidence: { kind: "form", url, form: { method: ref.method, action: ref.action }, result: "skipped" }, inputs: [] };
    artifacts = [await jsonEvidence(input.uploader, v.evidence)].filter((a): a is ArtifactRef => a !== null);
  } else {
    v = await checkForm(session, url, ref, input.environment.destructive_policy, ++formSeed);
    artifacts = [await screenshot(input.uploader, session), await jsonEvidence(input.uploader, v.evidence)].filter((a): a is ArtifactRef => a !== null);
  }
  input.sink.stepStarted({ key, node_id: t.node_id, executor, expected, input: { form: ref.key, url, role: t.app_role, inputs: v.inputs } });
  input.sink.stepFinished({ key, result: v.result, actual: v.actual, ...(artifacts.length > 0 ? { artifacts } : {}) });
  tally(summary, v.result, t.app_role);
}

/** A command is healthy when its --help still works and still has the same structure as when it was explored. */
async function checkCommand(input: RegressionInput, t: Target): Promise<Outcome> {
  if (!input.command) return { result: "error", actual: "no terminal runner is available for command targets" };
  const { result, help } = await helpOf(input.command, t.args ?? []);
  let outcome: Outcome;
  if (result.timedOut) outcome = { result: "error", actual: `timed out after ${result.durationMs} ms` };
  else if (result.exitCode !== 0) outcome = { result: "fail", actual: `exit code ${result.exitCode}: ${firstLine(result.stderr || result.stdout)}` };
  else if (t.help_signature && help.signature !== t.help_signature) {
    outcome = { result: "fail", actual: `exit code 0, help structure changed (signature ${help.signature} != ${t.help_signature})` };
  } else outcome = { result: "pass", actual: "exit code 0, help structure unchanged" };

  const evidence = `$ ${(t.args ?? []).join(" ")} --help\nexit code: ${result.exitCode}\n--- stdout ---\n${result.stdout.slice(0, 20_000)}\n--- stderr ---\n${result.stderr.slice(0, 5_000)}`;
  try {
    const ref = await input.uploader.upload("stdout", "text/plain", new TextEncoder().encode(evidence));
    return { ...outcome, artifacts: [ref] };
  } catch {
    return outcome; // evidence is best effort
  }
}

async function checkEndpoint(input: RegressionInput, t: Target, token: string | undefined): Promise<Outcome> {
  if (!t.method || !t.path || t.status === undefined) return { result: "error", actual: "endpoint target is incomplete" };
  const endpoint: EndpointTarget = { method: t.method, path: t.path, query: t.query ?? {}, status: t.status, schema: t.schema, body_required: t.body_required ?? false };
  const out = await callEndpoint({
    baseUrl: input.environment.base_url,
    allowedHosts: input.environment.allowed_hosts,
    target: endpoint,
    token,
    policy: input.environment.destructive_policy,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
  });
  if (out.kind === "skipped") return { result: "skipped", actual: out.reason };
  if (out.kind === "error") return { result: "error", actual: out.message };

  const verdict = checkContract(endpoint, out.response);
  // evidence: what was called and what came back; never the request headers, so the token cannot leak
  const evidence = JSON.stringify({
    request: { method: endpoint.method, url: out.response.url },
    response: { status: out.response.status, content_type: out.response.contentType, duration_ms: out.response.durationMs, truncated: out.response.truncated, body: out.response.body.slice(0, 20_000) },
  });
  try {
    const ref = await input.uploader.upload("http", "application/json", new TextEncoder().encode(evidence));
    return { ...verdict, artifacts: [ref] };
  } catch {
    return verdict; // evidence is best effort
  }
}

/** Evidence is best effort: a storage hiccup must not change the verdict of a step. */
async function screenshot(uploader: Uploader, session: Session): Promise<ArtifactRef | null> {
  if (!session.screenshot) return null;
  try {
    return await uploader.upload("screenshot", "image/png", await session.screenshot());
  } catch {
    return null;
  }
}

function record(input: RegressionInput, summary: RegressionSummary, t: Target, o: Outcome): void {
  const key = t.node_id;
  const reqs = t.requirement_keys.join(", ") || "no requirement";
  const isApi = t.kind === "endpoint";
  const isCommand = t.kind === "command";
  input.sink.stepStarted({
    key,
    node_id: t.node_id,
    executor: isCommand ? "terminal" : isApi ? "api" : input.environment.device ? "mobile_web" : "browser",
    expected: isCommand
      ? `exit code 0 and the same --help structure as when explored (${reqs})`
      : isApi
        ? `HTTP ${t.status ?? "?"}${t.schema ? " and a body that matches the contract" : ""} (${reqs})`
        : pageExpected(t),
    input: isCommand ? { args: t.args ?? [] } : isApi ? { method: t.method, path: t.path, query: t.query ?? {} } : { url: t.url, role: t.app_role },
  });
  input.sink.stepFinished({ key, result: o.result, actual: o.actual, ...(o.artifacts ? { artifacts: o.artifacts } : {}) });
  tally(summary, o.result, t.app_role);
}

function tally(summary: RegressionSummary, result: Outcome["result"], role: string): void {
  const mine = (summary.by_role[role] ??= { steps: 0, passed: 0, failed: 0, errors: 0, skipped: 0 });
  summary.steps++;
  mine.steps++;
  const bucket = result === "pass" ? "passed" : result === "fail" ? "failed" : result === "error" ? "errors" : "skipped";
  summary[bucket]++;
  mine[bucket]++;
}
