import { nodeFingerprint } from "../fingerprint/fingerprint.js";
import { routePattern } from "../fingerprint/route.js";
import type { Job } from "../protocol/schemas.js";
import { classifyIntent } from "./controls.js";
import { isAllowedUrl, shouldSkip, type DestructivePolicy } from "./guards.js";
import { addTotals, emitExamination, examinePage, newInteractiveState, zeroTotals, type Analyst, type Examination, type Followed, type InteractiveSession, type InteractiveState } from "./interactive.js";
import type { ActionResult, ActionSpec, Intent, Inventory } from "./interaction.js";
import { identityPlanner, type Planner } from "./planner.js";
import type { Uploader } from "./regression.js";
import type { EventSink } from "./sink.js";
import { SecurityScan, newScanShare } from "../security/scan.js";
import { confirmDown, isGatewayStatus, isInfraMessage } from "./health.js";
import type { PageFacts, SecurityCapabilities, Severity } from "../security/types.js";

export interface PageView {
  url: string; // final URL after redirects
  status: number;
  domSignature: string;
  links: { href: string; label: string }[];
  /** The page answered 200 but is showing an error screen ("Something went wrong"): the text it shows. */
  softError?: string;
  /** What the security checks read from the page (headers, forms, text). Present when the visit was asked to collect it. */
  security?: PageFacts;
}

export interface Session extends SecurityCapabilities {
  /** `security`: also read what the security checks need from the page. */
  visit(url: string, opts?: { security?: boolean }): Promise<PageView>;
  /** Forms and buttons of the current page. Present on sessions that can interact (a real browser). */
  inventory?(): Promise<Inventory>;
  /** Acts on the current page: clicks a button or fills and submits a form, and reports what happened. */
  perform?(action: ActionSpec): Promise<ActionResult>;
  /** PNG of the current page, used as evidence by regression runs. */
  screenshot?(): Promise<Uint8Array>;
  /** JPEG of the current page for the flow view, with what the person typed hidden. */
  thumbnail?(): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Why a login did not work, in terms of what the person can do about it. */
export type LoginFailureReason =
  /** No login form was found, not even by following a "Entrar" link or trying the usual addresses. */
  | "no_form"
  /** The form was filled and sent and the application kept the person out (wrong credentials, locked user). */
  | "rejected"
  /** A captcha or a one-time code: something a robot cannot do. */
  | "needs_more"
  /** The login goes through a site that is not in the allowed hosts (single sign-on). */
  | "sso_blocked"
  /** The application did not answer. */
  | "unreachable"
  | "error";

export interface LoginFailure {
  reason: LoginFailureReason;
  message: string;
}

/** Executor boundary (CLAUDE.md 4.3). `null` means the login failed; `loginFailure` says why. */
export interface Driver {
  newSession(role: string, credential: Credential | undefined): Promise<Session | null>;
  /** Why the last login of this user failed, when `newSession` returned null. */
  loginFailure?(role: string): LoginFailure | undefined;
}

/**
 * What kept a run from doing its job: the application is down, or no user could get in. It is one problem to fix, not a
 * bug in every screen, so a run that finds it reports it here and creates no bugs for it.
 */
export interface Blocked {
  kind: "app_down" | "login_failed";
  message: string;
  /** The users that could not get in. */
  roles?: string[];
  details?: { role: string; reason: LoginFailureReason; message: string }[];
}

export type Credential = Job["credentials"][number];

/** What a continued exploration already holds, from the graph of the interrupted one. */
export interface ResumeInput {
  /** How many explorations came before: keeps the test data of this one apart from theirs. */
  generation: number;
  /** The screens already examined, per user, and where the actions on them led. */
  known: { fingerprint: string; app_role: string; followed?: { url: string; label: string; type: "submit" | "search" | "click"; intent: Intent }[] }[];
}

export interface ExploreInput {
  driver: Driver;
  sink: EventSink;
  environment: { base_url: string; allowed_hosts: string[]; destructive_policy: DestructivePolicy; device?: string | undefined };
  credentials: Credential[];
  budget: Job["budget"];
  shouldStop: () => boolean;
  /** Orders and filters the new links to follow. Defaults to the natural order. */
  planner?: Planner;
  /** Reads each page with the LLM when interacting; without it the page is read from its own words. */
  analyst?: Analyst;
  /** Where the pictures of the screens go. Without it no pictures are taken. */
  uploader?: Uploader;
  /** Set when this run continues an interrupted exploration: known screens are not examined again. */
  resume?: ResumeInput;
  /** Whether the application is down, asked only when something failed in a way that could mean so. Defaults to asking it. */
  isDown?: (url: string) => Promise<{ down: boolean; detail: string }>;
}

export interface ExploreSummary {
  pages: number;
  skipped_out_of_scope: number;
  skipped_destructive: number;
  http_errors: { url: string; status: number; from: string | null }[];
  errors: { url: string; message: string }[];
  login_failures: string[];
  /** Why each of those users could not get in. */
  login_failure_details: { role: string; reason: LoginFailureReason; message: string }[];
  /** What kept the run from its job (application down, nobody could log in): one problem to fix, not bugs. */
  blocked?: Blocked;
  /** Screens that answered 200 but show an error: they are failures too, and no status code says so. */
  soft_errors: { url: string; message: string }[];
  /** Pictures of screens sent for the flow view. */
  thumbnails: number;
  /** What each user reached: the run says who was explored (a user that could not log in has no screens). */
  by_role: Record<string, { pages: number; login_ok: boolean }>;
  /** New links the planner chose not to follow. */
  planner_skipped: number;
  /** Continuation: how many of the visits were to screens the interrupted exploration had already examined. */
  resumed?: { known_pages: number };
  /** Interactive part (budget.max_actions > 0): pages read, what was tried and what was learned. */
  interactive?: InteractiveState["totals"];
  /** Security checks made along the way (they run unless the run turned them off). */
  security?: { checks: number; failed: number; by_severity: Record<Severity, number>; probes: number };
  stopped_by: "exhausted" | "max_pages" | "max_seconds" | "cancelled" | "blocked";
}

interface PendingEdge {
  fromFp: string;
  key: string;
  label: string;
  /** Extra fields of the edge's action (a form submission leading somewhere is not a plain link). */
  action?: Record<string, unknown>;
}

interface QueueItem {
  url: string;
  depth: number;
  from: { viewUrl: string } | null;
}

/**
 * Deterministic breadth-first exploration through links, one session per role. Up to MAX_SAMPLES_PER_PATTERN
 * URLs per route pattern are visited (data-dependent failures surface), but same screen with different data
 * stays a single node via the fingerprint (CLAUDE.md seção 9). Scope and destructive policy are enforced
 * here and again in the executor.
 */
export async function explore(input: ExploreInput): Promise<ExploreSummary> {
  const summary: ExploreSummary = {
    pages: 0,
    skipped_out_of_scope: 0,
    skipped_destructive: 0,
    http_errors: [],
    errors: [],
    login_failures: [],
    login_failure_details: [],
    soft_errors: [],
    thumbnails: 0,
    by_role: {},
    planner_skipped: 0,
    stopped_by: "exhausted",
  };
  const deadline = Date.now() + input.budget.max_seconds * 1000;
  const outOfScope = new Set<string>();
  const destructive = new Set<string>();
  const roles = input.credentials.length > 0 ? input.credentials : [undefined];
  const isDown = input.isDown ?? ((u: string) => confirmDown(u));
  const appDown = (detail: string): void => {
    summary.blocked = { kind: "app_down", message: appDownMessage(input.environment.base_url, detail) };
    summary.stopped_by = "blocked";
  };
  const maxActions = input.budget.max_actions ?? 0;
  const totals = zeroTotals();
  if (input.resume) summary.resumed = { known_pages: 0 };
  const share = newScanShare();
  const secTotals = { checks: 0, failed: 0, by_severity: { critical: 0, high: 0, normal: 0 } as Record<Severity, number>, probes: 0 };

  for (const [index, credential] of roles.entries()) {
    const role = credential?.app_role ?? "anonymous";
    const session = await input.driver.newSession(role, credential);
    if (!session) {
      const why = input.driver.loginFailure?.(role) ?? { reason: "rejected" as const, message: "o login não foi aceito" };
      summary.login_failures.push(role);
      summary.login_failure_details.push({ role, reason: why.reason, message: why.message });
      summary.by_role[role] = { pages: 0, login_ok: false };
      if (why.reason === "unreachable") {
        const d = await isDown(input.environment.base_url);
        if (d.down) {
          appDown(d.detail);
          break; // nobody else will get in either
        }
      }
      continue;
    }
    summary.by_role[role] = { pages: 0, login_ok: true };
    // every user gets the whole action budget and their own record of endpoints and windows: sharing them would leave the
    // second user with what the first left over, and the alternative flows are exactly what the second user sees
    const interactive = maxActions > 0 ? newInteractiveState(maxActions, input.analyst, (input.resume?.generation ?? 0) * 100_000 + index * 1000) : undefined;
    const known = new Map(input.resume?.known.filter((k) => k.app_role === role).map((k) => [k.fingerprint, k.followed ?? []]));
    const scan = input.budget.no_security
      ? undefined
      : new SecurityScan({ sink: input.sink, uploader: input.uploader, environment: input.environment, executor: input.environment.device ? "mobile_web" : "browser", role, share });
    try {
      const stop = await exploreRole(input, session, role, summary, deadline, outOfScope, destructive, interactive, known, scan, isDown, appDown);
      if (stop && stop !== "exhausted") {
        summary.stopped_by = stop;
        if (stop === "cancelled" || stop === "max_seconds" || stop === "blocked") break; // global limits end the whole run
      }
    } finally {
      if (scan) await finishScan(scan, session, secTotals);
      await session.close();
      if (interactive) addTotals(totals, interactive.totals);
    }
  }
  summary.skipped_out_of_scope = outOfScope.size;
  summary.skipped_destructive = destructive.size;
  if (maxActions > 0) summary.interactive = totals;
  if (!input.budget.no_security) summary.security = secTotals;
  if (!summary.blocked && summary.login_failure_details.length > 0) {
    summary.blocked = loginBlocked(summary.login_failure_details);
    if (summary.pages === 0) summary.stopped_by = "blocked"; // nobody got in: there is nothing to say about the application
  }
  return summary;
}

/** What to tell the person when the application did not answer: one sentence, and what to do. */
export function appDownMessage(baseUrl: string, detail: string): string {
  return `A aplicação não respondeu em ${baseUrl}: ${detail}. Ponha a aplicação no ar (ou confira o endereço do ambiente) e rode de novo.`;
}

/** What to tell the person when users could not get in: who, why, and what to do. */
export function loginBlocked(details: { role: string; reason: LoginFailureReason; message: string }[]): Blocked {
  const who = details.map((d) => d.role);
  const first = details[0];
  const why = first ? `${first.message.replace(/\.$/, "")}` : "";
  return {
    kind: "login_failed",
    roles: who,
    details,
    message: `Não foi possível entrar como ${who.join(", ")}: ${why}. Corrija o login (usuário, senha ou acesso) em Configurações → Credenciais e rode de novo.`,
  };
}

/** The cookies are read last, when the application has had every chance to set them, then the findings become steps. */
async function finishScan(scan: SecurityScan, session: Session, totals: NonNullable<ExploreSummary["security"]>): Promise<void> {
  try {
    await scan.finish(session);
  } catch {
    // a security check that cannot be written down never costs the map
  }
  const s = scan.summary();
  totals.checks += s.checks;
  totals.failed += s.failed;
  totals.probes += s.probes;
  for (const k of Object.keys(s.by_severity) as Severity[]) totals.by_severity[k] += s.by_severity[k];
}

const MAX_SAMPLES_PER_PATTERN = 3;

async function exploreRole(
  input: ExploreInput,
  session: Session,
  role: string,
  summary: ExploreSummary,
  deadline: number,
  outOfScope: Set<string>,
  destructive: Set<string>,
  interactive: InteractiveState | undefined,
  /** Screens of this user a previous run examined (fingerprint -> where their actions led): not examined again. */
  known: Map<string, NonNullable<ResumeInput["known"][number]["followed"]>>,
  scan: SecurityScan | undefined,
  isDown: (url: string) => Promise<{ down: boolean; detail: string }>,
  appDown: (detail: string) => void,
): Promise<ExploreSummary["stopped_by"]> {
  const { budget, environment, sink } = input;
  const planner = input.planner ?? identityPlanner;
  const queue: QueueItem[] = [{ url: environment.base_url, depth: 0, from: null }];
  const queuedUrls = new Set<string>([environment.base_url]);
  const samples = new Map<string, string[]>([[routePattern(environment.base_url), [environment.base_url]]]); // pattern -> queued URLs
  const urlToFp = new Map<string, string>();
  const pending = new Map<string, PendingEdge[]>(); // queued URL -> edges waiting for its node
  const emittedNodes = new Set<string>();
  const emittedEdges = new Set<string>();
  let pages = 0; // new screens only: what the interrupted exploration already examined does not use up this one's budget

  const emitEdge = (e: PendingEdge, toFp: string, pattern: string): void => {
    if (e.fromFp === toFp) return; // self-loops add nothing to the map
    const id = `${e.fromFp}|${toFp}|${e.key}`;
    if (emittedEdges.has(id)) return;
    emittedEdges.add(id);
    sink.edge({ key: e.key, from_fingerprint: e.fromFp, to_fingerprint: toFp, action: { type: "navigate", href: pattern, label: e.label, ...e.action }, app_role: role });
  };
  // Attach an edge to a queued URL: emit now if its node is known, otherwise when it is visited.
  const connect = (edge: PendingEdge, url: string, pattern: string): void => {
    const fp = urlToFp.get(url);
    if (fp) emitEdge(edge, fp, pattern);
    else pending.set(url, [...(pending.get(url) ?? []), edge]);
  };

  while (queue.length > 0) {
    if (input.shouldStop()) return "cancelled";
    if (Date.now() >= deadline) return "max_seconds";
    if (pages >= budget.max_pages) return "max_pages";

    const item = queue.shift() as QueueItem;
    const pattern = routePattern(item.url);
    let view: PageView;
    try {
      view = await session.visit(item.url, scan ? { security: true } : undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push({ url: item.url, message });
      pending.delete(item.url);
      // a page that cannot load is a problem of the page, unless the whole application went away: then it is one problem
      if (isInfraMessage(message)) {
        const d = await isDown(environment.base_url);
        if (d.down) {
          appDown(d.detail);
          return "blocked";
        }
      }
      continue;
    }
    if (isGatewayStatus(view.status)) {
      const d = await isDown(environment.base_url);
      if (d.down) {
        appDown(d.detail);
        return "blocked";
      }
    }
    summary.pages++;
    const mine = summary.by_role[role];
    if (mine) mine.pages++;
    if (view.status >= 400) summary.http_errors.push({ url: item.url, status: view.status, from: item.from?.viewUrl ?? null });
    else if (view.softError) summary.soft_errors.push({ url: item.url, message: view.softError });

    const fp = nodeFingerprint({ url: view.url, domSignature: view.domSignature, appRole: role });
    urlToFp.set(item.url, fp);

    // A screen the interrupted exploration examined: it is not announced, examined or photographed again, but its links
    // (and where its actions had led) are followed, because the frontier of the unfinished work is behind them.
    const earlier = known.get(fp);
    let rememberedLed: Followed[] = [];
    if (earlier && !emittedNodes.has(fp)) {
      emittedNodes.add(fp);
      if (summary.resumed) summary.resumed.known_pages++;
      rememberedLed = earlier.map((f) => ({ url: f.url, label: f.label, action: { type: f.type, intent: f.intent } }));
    }
    if (!earlier) pages++;

    // The picture of a screen is taken the moment it is found, before anything acts on it (acting changes the page).
    let picture: Uint8Array | null = null;
    if (input.uploader && session.thumbnail && !emittedNodes.has(fp)) picture = await session.thumbnail().catch(() => null);

    // Interactive reading of a screen it has not seen before: what is on it, what the controls do, what happens when
    // they are used. It comes before the node is sent, because a node's metadata is fixed by the first event.
    let examination: Examination | undefined;
    if (interactive && !emittedNodes.has(fp) && view.status < 400 && session.inventory && session.perform) {
      try {
        examination = await examinePage(session as InteractiveSession, item.url, routePattern(view.url), interactive, {
          policy: environment.destructive_policy,
          deadline,
          shouldStop: input.shouldStop,
        });
      } catch (err) {
        summary.errors.push({ url: item.url, message: `interaction: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    if (!emittedNodes.has(fp)) {
      emittedNodes.add(fp);
      sink.node({
        fingerprint: fp,
        kind: "page",
        label: routePattern(view.url),
        app_role: role,
        metadata: { status: view.status, url: stableUrl(view.url), ...queryNames(view.url), ...(view.softError ? { soft_error: view.softError } : {}), ...(examination?.metadata ?? {}) },
      });
      if (picture && input.uploader) {
        // best effort, like all evidence: a picture that cannot be stored must not cost the map a screen
        try {
          const artifact = await input.uploader.upload("screenshot", "image/jpeg", picture);
          sink.nodeThumbnail({ fingerprint: fp, artifact });
          summary.thumbnails++;
        } catch {
          // no picture for this screen
        }
      }
    }
    for (const e of pending.get(item.url) ?? []) emitEdge(e, fp, pattern);
    pending.delete(item.url);
    scan?.page(view, { fingerprint: fp }, routePattern(view.url), session);
    const followed =
      interactive && examination ? emitExamination(sink, interactive, { pageFp: fp, pageUrl: view.url, route: routePattern(view.url), role }, examination) : rememberedLed;

    // the injections come after everything that acts on the page: they take the browser to other addresses
    // (the address asked for, not where it ended: a redirect parameter is exactly an address that leaves its query behind)
    if (scan && view.status < 400) await scan.after(session, { url: item.url, security: view.security }, { fingerprint: fp }, routePattern(view.url)).catch(() => undefined);

    if (item.depth >= budget.max_depth) continue;

    // Edges to already-queued URLs are recorded right away; genuinely new targets go through the planner.
    const fresh: { target: string; pattern: string; edge: PendingEdge; label: string }[] = [];
    const freshUrls = new Set<string>();
    const candidates: { href: string; label: string; via?: Followed["action"] }[] = [
      ...view.links,
      ...followed.map((f) => ({ href: f.url, label: f.label, via: f.action })),
    ];
    for (const link of candidates) {
      const target = classify(link, environment, outOfScope, destructive);
      if (!target) continue;
      const targetPattern = routePattern(target);
      const edge: PendingEdge = link.via
        ? { fromFp: fp, key: `${link.via.type} ${link.label} → ${targetPattern}`.slice(0, 480), label: link.label, action: link.via }
        : { fromFp: fp, key: `link ${targetPattern}`, label: link.label };
      if (queuedUrls.has(target)) connect(edge, target, targetPattern);
      else if (!freshUrls.has(target)) {
        freshUrls.add(target);
        fresh.push({ target, pattern: targetPattern, edge, label: link.label });
      }
    }
    const order = await rankFresh(planner, fresh, view.url, item.depth, [...samples.keys()], summary, (i) => fresh[i]?.edge.action !== undefined);
    for (const idx of order) {
      const f = fresh[idx];
      if (!f) continue;
      const known = samples.get(f.pattern) ?? [];
      if (known.length < MAX_SAMPLES_PER_PATTERN) {
        queuedUrls.add(f.target);
        samples.set(f.pattern, [...known, f.target]);
        pending.set(f.target, [f.edge]);
        queue.push({ url: f.target, depth: item.depth + 1, from: { viewUrl: view.url } });
      } else connect(f.edge, known[0] as string, f.pattern); // sample cap reached: point at the first sample
    }
  }
  return "exhausted";
}

/** Returns the URL to follow, or null when the link is ignored (non-http, out of scope, destructive). */
function classify(
  link: { href: string; label: string },
  env: ExploreInput["environment"],
  outOfScope: Set<string>,
  destructive: Set<string>,
): string | null {
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null; // mailto:, javascript:, tel:...
  url.hash = "";
  const href = url.toString();
  if (!isAllowedUrl(href, env.allowed_hosts)) {
    outOfScope.add(href);
    return null;
  }
  // logging out or removing the account would end the exploration itself, whatever the environment allows
  if (classifyIntent(link.label, { href: url.pathname }) === "never" || shouldSkip({ label: link.label, href: url.pathname + url.search }, env.destructive_policy)) {
    destructive.add(href);
    return null;
  }
  return href;
}

/** Planner order restricted to valid, unique indices; any planner failure means the natural order. */
async function rankFresh(
  planner: Planner,
  fresh: { pattern: string; label: string; target: string }[],
  url: string,
  depth: number,
  visited: string[],
  summary: ExploreSummary,
  /** Where an action already led (a form sent, a search, a click): it exists whatever the planner thinks. */
  mustFollow: (index: number) => boolean = () => false,
): Promise<number[]> {
  const natural = fresh.map((_, i) => i);
  if (fresh.length === 0) return natural;
  let order: number[];
  try {
    order = await planner.rank(
      { url, route: routePattern(url), depth, visited },
      fresh.map((f) => ({ label: f.label, route: f.pattern, known: visited.includes(f.pattern) })),
    );
  } catch {
    return natural;
  }
  const seen = new Set<number>();
  const valid = order.filter((i) => Number.isInteger(i) && i >= 0 && i < fresh.length && !seen.has(i) && seen.add(i));
  // the AI orders what to visit and may drop plain links; it does not decide whether a result the agent already got exists
  // (otherwise two users with the same screen would show different maps just because the model felt differently)
  const forced = natural.filter((i) => !seen.has(i) && mustFollow(i));
  summary.planner_skipped += fresh.length - valid.length - forced.length;
  return [...valid, ...forced];
}

/** The names of the parameters a page was found with (never their values), so a regression can try injections on them. */
function queryNames(url: string): { query?: string[] } {
  const names = [...new Set(new URL(url).searchParams.keys())].slice(0, 5);
  return names.length > 0 ? { query: names } : {};
}

/** URL without query or hash: stable enough to revisit the node later, and never carries tokens from query strings. */
function stableUrl(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}
