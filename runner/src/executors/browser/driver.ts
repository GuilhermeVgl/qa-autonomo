import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Request } from "playwright";
import { effectiveMethod, formEncodedFields } from "../../agent/controls.js";
import { isAllowedUrl, type DestructivePolicy } from "../../agent/guards.js";
import type { Credential, Driver, LoginFailure, PageView, Session } from "../../agent/explorer.js";
import type { ActionResult, ActionSpec, Inventory, ObservedRequest } from "../../agent/interaction.js";
import { domSignature } from "../../fingerprint/dom.js";
import { CookieJar } from "../../security/cookies.js";
import { collectPageFacts } from "../../security/pagefacts.js";
import type { CookieFlag, PageFacts, ProbeOutcome, RawResponse } from "../../security/types.js";
import { collectInventory } from "./inventory.js";
import { performLogin } from "./login.js";
import { analyzeLoginPage } from "./loginpage.js";
import { detectSoftError } from "./softerror.js";

const NAV_TIMEOUT_MS = 15_000;

export interface BrowserScope {
  base_url: string;
  allowed_hosts: string[];
  /** Playwright device descriptor name; set for mobile_web environments. */
  device?: string | undefined;
  /** Without `allow`, every request that writes (POST/PUT/PATCH/DELETE) made while the agent acts on a page is aborted. */
  destructive_policy?: DestructivePolicy | undefined;
  /** Also read what the security checks need: the cookies the application sets (Set-Cookie) on every response. */
  security?: boolean | undefined;
}

/** What the page did while the agent acted on it: requests (with the verb they really mean) and native dialogs. */
interface Watch {
  active: boolean;
  guardWrites: boolean;
  acceptDialogs: boolean;
  requests: Map<Request, ObservedRequest>;
  dialog: string | null;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Playwright executor. The scope guard runs at the network layer of every context (CLAUDE.md, seção 12):
 * requests to hosts outside allowed_hosts are aborted no matter what the agent or the page asks for.
 */
export class BrowserDriver implements Driver {
  /** Requests aborted by the scope guard, reported in the run summary. */
  readonly blockedRequests = new Set<string>();
  /** Why each user's last login did not work. */
  private readonly loginFailures = new Map<string, LoginFailure>();

  private constructor(
    private readonly browser: Browser,
    private readonly scope: BrowserScope,
  ) {}

  static async launch(scope: BrowserScope): Promise<BrowserDriver> {
    if (scope.device && !devices[scope.device]) throw new Error(`unknown device "${scope.device}"`);
    return new BrowserDriver(await chromium.launch({ headless: true }), scope);
  }

  async newSession(role: string, credential: Credential | undefined): Promise<Session | null> {
    const emulation = this.scope.device ? devices[this.scope.device] : undefined;
    // kind=session: start the context already authenticated, bypassing any login flow (SSO, 2FA, captcha).
    let storageState: BrowserContextOptions["storageState"];
    if (credential?.kind === "session") {
      try {
        storageState = JSON.parse(credential.payload["state"] ?? "") as BrowserContextOptions["storageState"];
      } catch {
        this.loginFailures.set(role, { reason: "session_expired", message: "a sessão salva está corrompida: recapture com `npm run capture`" });
        return null;
      }
    }
    const context = await this.browser.newContext({ ...emulation, ignoreHTTPSErrors: false, storageState });
    const blockedLoginHosts = new Set<string>();
    const watch: Watch = { active: false, guardWrites: false, acceptDialogs: false, requests: new Map(), dialog: null };
    await context.route("**/*", (route) => {
      const req = route.request();
      const url = req.url();
      if (!isAllowedUrl(url, this.scope.allowed_hosts)) {
        this.blockedRequests.add(url);
        if (isLoginRelevantBlock(req)) blockedLoginHosts.add(hostOf(url));
        return route.abort("blockedbyclient");
      }
      if (!watch.active) return route.continue();
      const type = req.resourceType();
      const body = req.postData();
      const write = WRITE_METHODS.has(req.method().toUpperCase());
      if (type === "document" || type === "xhr" || type === "fetch") {
        const record: ObservedRequest = {
          method: effectiveMethod(req.method(), body),
          path: new URL(url).pathname,
          resource: type === "document" ? "document" : type,
          status: null,
          blocked: false,
          fields: formEncodedFields(body, req.headers()["content-type"] ?? null),
        };
        watch.requests.set(req, record);
        if (watch.guardWrites && write) {
          record.blocked = true; // learned, never sent: the environment does not allow changing data
          return route.abort("blockedbyclient");
        }
      } else if (watch.guardWrites && write) {
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    const jar = new CookieJar();
    page.on("response", (res) => {
      const record = watch.requests.get(res.request());
      if (record) record.status = res.status();
      // the flags a cookie was set with are only in the raw header: the browser's own cookie list leaves out what it defaulted
      if (this.scope.security && ["document", "xhr", "fetch"].includes(res.request().resourceType())) {
        void res
          .headerValue("set-cookie")
          .then((v) => v && jar.record(v))
          .catch(() => undefined);
      }
    });
    page.on("dialog", (dialog) => {
      if (watch.active) watch.dialog = dialog.message().slice(0, 300);
      // a confirmation is answered only when the agent chose to go through with the action; leaving a page never blocks
      const accept = dialog.type() === "beforeunload" || (watch.active && watch.acceptDialogs);
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });

    if (credential?.kind === "api_token") {
      const token = credential.payload["token"];
      if (token) await context.setExtraHTTPHeaders({ authorization: `Bearer ${token}` });
    } else if (credential?.kind === "session") {
      // the saved session may have expired: if the home page shows a login wall, it no longer authenticates.
      const expired = await sessionExpired(page, this.scope.base_url);
      if (expired) {
        this.loginFailures.set(role, { reason: "session_expired", message: "a sessão salva expirou: recapture com `npm run capture`" });
        await context.close();
        return null;
      }
      this.loginFailures.delete(role);
    } else if (credential?.kind === "login") {
      const outcome = await performLogin(page, this.scope.base_url, credential.payload, { blockedHosts: () => [...blockedLoginHosts] });
      if (!outcome.ok) {
        this.loginFailures.set(role, { reason: outcome.reason, message: outcome.message });
        await context.close();
        return null;
      }
      this.loginFailures.delete(role);
    }
    void role;
    return new BrowserSession(context, page, watch, this.scope.destructive_policy ?? "block", jar, this.scope.allowed_hosts);
  }

  loginFailure(role: string): LoginFailure | undefined {
    return this.loginFailures.get(role);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const isLoginRelevantBlock = (req: Request): boolean => {
  if (req.isNavigationRequest()) return true;
  const type = req.resourceType();
  return type === "document" || type === "xhr" || type === "fetch";
};

/** Whether a saved session no longer authenticates: the home page offers a way to log in (form, first step, or a link). */
async function sessionExpired(page: Page, baseUrl: string): Promise<boolean> {
  try {
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
  } catch {
    return false; // a navigation error here is not an expiry; the run's health checks handle the app being down
  }
  for (let i = 0; i < 5; i++) {
    try {
      const a = (await page.evaluate(`(${analyzeLoginPage.toString()})(document, location.href, false)`)) as { hasPassword: boolean; firstStep: boolean; loginLink: unknown };
      return a.hasPassword || a.firstStep || a.loginLink !== null;
    } catch {
      await sleep(200);
    }
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REF = /^[a-z]\d{1,4}$/; // refs are handed out by collectInventory; nothing else may reach a selector
const formKey = (f: Inventory["forms"][number]) => `${f.method} ${f.action} ${f.label} ${f.submitLabel}`;

/** Requests that mean "the page is still loading its content": scripts, data calls and documents; not images or streams. */
const TRACKED = new Set(["document", "script", "xhr", "fetch"]);

class BrowserSession implements Session {
  private lastInventory: Inventory | null = null;
  /** Requests of the page that have not finished: the page is not ready while data it asked for is still coming. */
  private readonly inflight = new Set<Request>();

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly watch: Watch,
    private readonly policy: DestructivePolicy,
    private readonly jar: CookieJar,
    private readonly allowedHosts: string[],
  ) {
    page.on("request", (r) => TRACKED.has(r.resourceType()) && this.inflight.add(r));
    page.on("requestfinished", (r) => this.inflight.delete(r));
    page.on("requestfailed", (r) => this.inflight.delete(r));
  }

  /** Waits until nothing the page asked for is in flight for `quietMs` (or `maxMs` passes: a long poll never ends). */
  private async idleNetwork(quietMs: number, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (this.inflight.size === 0) {
        await sleep(quietMs);
        if (this.inflight.size === 0) return;
      } else await sleep(40);
    }
  }

  async visit(url: string, opts?: { security?: boolean }): Promise<PageView> {
    const response = await this.page.goto(url, { waitUntil: "load" });
    await this.stabilize();
    const snapshot = await this.page.evaluate(`(() => {
      const sig = (${domSignature.toString()})(document.body);
      const chromeSel = "header, nav, aside, [role=banner], [role=navigation], [role=complementary], [role=menubar]";
      const isChrome = (el) => {
        if (el.closest(chromeSel)) return true;
        let p = el;
        for (let i = 0; p && i < 10; i++, p = p.parentElement) {
          const pos = getComputedStyle(p).position;
          if (pos === "fixed" || pos === "sticky") return true;
        }
        return false;
      };
      const links = [...document.querySelectorAll("a[href]")].map((a) => ({
        href: a.href,
        label: (a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 120),
        chrome: isChrome(a),
      }));
      const soft = (${detectSoftError.toString()})(document);
      return { sig, links, soft };
    })()`);
    const { sig, links, soft } = snapshot as { sig: string; links: { href: string; label: string; chrome?: boolean }[]; soft: string | null };
    const status = response?.status() ?? 0;
    const security = opts?.security ? await this.readSecurity(response) : undefined;
    return { url: this.page.url(), status, domSignature: sig, links, ...(soft && status < 400 ? { softError: soft } : {}), ...(security ? { security } : {}) };
  }

  /** What the security checks need from the page that was just loaded: its response headers and what its document holds. */
  private async readSecurity(response: Awaited<ReturnType<Page["goto"]>>): Promise<PageFacts | undefined> {
    try {
      const headers = response ? await response.allHeaders() : {};
      const facts = (await this.page.evaluate(`(${collectPageFacts.toString()})(document, location.href)`)) as Omit<PageFacts, "headers" | "html">;
      return { headers, html: /html/i.test(headers["content-type"] ?? ""), ...facts };
    } catch {
      return undefined; // a page the checks cannot read is not a reason to lose the page
    }
  }

  /** The cookies the application set in this session, with the flags it set them with. */
  cookieFlags(): CookieFlag[] {
    return this.jar.flags();
  }

  /**
   * Loads an address and reports whether the markers put in its parameters became elements of the page, and what the page
   * says. A read of an allowed address; the browser's own scope guard sits in front of it as for any navigation.
   */
  async probe(url: string): Promise<ProbeOutcome | null> {
    if (!isAllowedUrl(url, this.allowedHosts)) return null;
    try {
      const response = await this.page.goto(url, { waitUntil: "load" });
      await this.idleNetwork(60, 1500);
      const seen = (await this.page.evaluate(`(() => {
        const injected = [];
        for (const el of document.querySelectorAll("*")) {
          const m = /^qaxss(\\d+)$/i.exec(el.tagName);
          if (m) injected.push(Number(m[1]));
        }
        const text = [document.title, document.body ? (document.body.innerText || document.body.textContent || "") : ""].join("\\n").slice(0, 20000);
        return { injected, text };
      })()`)) as { injected: number[]; text: string };
      return { status: response?.status() ?? 0, finalUrl: this.page.url(), injected: [...new Set(seen.injected)], text: seen.text };
    } catch {
      return null;
    }
  }

  /**
   * A GET that does not follow redirects, with the session's cookies. It bypasses the browser's request guard, so the scope
   * is checked here, and nothing it is given is ever followed to another address.
   */
  async rawGet(url: string, opts?: { origin?: string }): Promise<RawResponse | null> {
    if (!isAllowedUrl(url, this.allowedHosts)) return null;
    try {
      const res = await this.context.request.get(url, { maxRedirects: 0, failOnStatusCode: false, timeout: 8000, ...(opts?.origin ? { headers: { origin: opts.origin } } : {}) });
      const body = await res.text().catch(() => "");
      return { status: res.status(), headers: res.headers(), body: body.slice(0, 20_000) };
    } catch {
      return null;
    }
  }

  /**
   * "load" is only the start for an SPA: content and links are drawn afterwards, and lists load more as they are scrolled.
   * Reading too early gives a map with holes and a structure that differs from one visit to the next, which regression then
   * reports as a bug. So wait for the network to go quiet, for the DOM to stop changing, and scroll long pages to the end.
   */
  private async stabilize(): Promise<void> {
    // a static page costs one short pause; a page still loading its data costs what the data takes
    await this.idleNetwork(60, 3000);
    await this.page
      .evaluate(
        `(async () => {
          const quiet = (idle, max) => new Promise((resolve) => {
            let timer;
            const done = () => { obs.disconnect(); clearTimeout(timer); resolve(); };
            const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, idle); });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            timer = setTimeout(done, idle);
            setTimeout(done, max);
          });
          // an SPA shell: the main content is still empty (and the page runs scripts), whatever the menu around it shows.
          // Content drawn by a timer or a framework leaves no trace on the network, so give it time to appear. A small
          // server-rendered page has no scripts to wait for and costs nothing.
          const root = document.querySelector("main, [role=main], #app, #root, #__next") || document.body;
          const empty = () => (root.innerText || "").trim().length < 40 && !root.querySelector("a[href], input, textarea, select, table, img");
          if (document.querySelector("script")) for (let i = 0; i < 15 && empty(); i++) await new Promise((r) => setTimeout(r, 100));
          await quiet(80, 1500);
          let scrolled = false;
          for (let i = 0; i < 4; i++) {
            const h = document.documentElement.scrollHeight;
            if (h <= window.innerHeight * 1.2) break;
            scrolled = true;
            window.scrollTo(0, h);
            await new Promise((r) => setTimeout(r, 250));
            if (document.documentElement.scrollHeight <= h) break;
          }
          if (scrolled) { window.scrollTo(0, 0); await quiet(80, 800); }
        })()`,
      )
      .catch(() => undefined);
    await this.idleNetwork(40, 1500); // what scrolling or rendering asked for
  }

  /** The links on the page as it is now; used to tell what an action revealed. */
  private async readLinks(): Promise<{ href: string; label: string }[]> {
    return (await this.page
      .evaluate(
        `[...document.querySelectorAll("a[href]")].map((a) => ({ href: a.href, label: (a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 120) }))`,
      )
      .catch(() => [])) as { href: string; label: string }[];
  }

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot({ type: "png" });
  }

  /** What the flow view shows for the screen: a small JPEG, with every field covered so nothing typed or prefilled leaks. */
  async thumbnail(): Promise<Uint8Array> {
    return this.page.screenshot({ type: "jpeg", quality: 55, mask: [this.page.locator("input:not([type=hidden]), textarea, select")], maskColor: "#c9ccd6" });
  }

  /** Forms and buttons of the page as it is now; tags them so `perform` can find them. */
  async inventory(): Promise<Inventory> {
    this.lastInventory = (await this.page.evaluate(`(${collectInventory.toString()})(document, false)`)) as Inventory;
    return this.lastInventory;
  }

  /** Clicks a button or fills and submits a form, and reports what the page did in response. */
  async perform(action: ActionSpec): Promise<ActionResult> {
    const before = this.lastInventory ?? (await this.inventory());
    const urlBefore = this.page.url();
    const linksBefore = new Set((await this.readLinks()).map((l) => l.href));
    const w = this.watch;
    w.requests.clear();
    w.dialog = null;
    w.acceptDialogs = action.accept === true;
    w.guardWrites = this.policy !== "allow";
    w.active = true;
    let failure: string | null = null;
    try {
      if (action.type === "click") {
        if (!REF.test(action.ref)) throw new Error("invalid reference");
        await this.page.locator(`[data-qa-ref="${action.ref}"]`).first().click({ timeout: 4000 });
      } else {
        await this.fillAndSubmit(action);
      }
      await this.settle();
    } catch (err) {
      failure = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
    } finally {
      w.active = false;
      w.guardWrites = false;
    }

    const requests = [...w.requests.values()];
    const urlAfter = this.page.url();
    const navigated = stripHash(urlAfter) !== stripHash(urlBefore);
    const status = [...w.requests.values()].reverse().find((r) => r.resource === "document" && r.status !== null)?.status ?? null;

    let modal: ActionResult["modal"] = null;
    let messages: string[] = [];
    let revealed: { href: string; label: string }[] = [];
    if (!navigated) {
      // a menu, a tab or an accordion opened by the action: links that were not there before
      revealed = (await this.readLinks()).filter((l) => !linksBefore.has(l.href) && isHttp(l.href) && stripHash(l.href) !== stripHash(urlAfter));
      const after = await this.inventory().catch(() => null);
      if (after) {
        const known = new Set(before.forms.map(formKey));
        const newForms = after.forms.filter((f) => !known.has(formKey(f)));
        const knownButtons = new Set(before.buttons.map((b) => b.label));
        const newButtons = after.buttons.filter((b) => !knownButtons.has(b.label));
        if (newForms.length > 0) {
          const ref = newForms[0]?.ref ?? "";
          const signature = await this.page.evaluate(
            `((ref) => { const f = document.querySelector('[data-qa-ref="' + ref + '"]'); const box = f && (f.closest('[role=dialog], dialog, turbo-frame') || f); return 'modal:' + (${domSignature.toString()})(box); })(${JSON.stringify(ref)})`,
          ) as string;
          modal = { signature, inventory: { title: "", headings: [], forms: newForms, buttons: newButtons } };
        }
      }
      messages = await this.messages(action.type === "submit" && requests.length === 0);
    } else {
      messages = await this.messages(false);
    }
    if (failure) messages = [`não foi possível agir: ${failure.slice(0, 160)}`, ...messages];
    return { requests, navigatedTo: navigated && isHttp(urlAfter) ? urlAfter : null, status, modal, messages, dialog: w.dialog, ...(revealed.length > 0 ? { links: revealed.slice(0, 30) } : {}) };
  }

  private async fillAndSubmit(action: Extract<ActionSpec, { type: "submit" }>): Promise<void> {
    const refs = [action.formRef, action.submitRef ?? "a0", ...Object.keys(action.values)];
    if (!refs.every((r) => REF.test(r))) throw new Error("invalid reference");
    const form = this.page.locator(`[data-qa-ref="${action.formRef}"]`).first();
    for (const [ref, value] of Object.entries(action.values)) {
      const el = form.locator(`[data-qa-ref="${ref}"]`).first();
      try {
        const kind = await el.evaluate((n) => (n.tagName === "SELECT" ? "select" : ((n as HTMLInputElement).type ?? "text").toLowerCase()));
        if (kind === "select") await el.selectOption(String(value), { timeout: 2000 });
        else if (kind === "checkbox" || kind === "radio") await el.setChecked(value === true || value === "true", { timeout: 2000 });
        else if (typeof value === "string") await el.fill(value, { timeout: 2000 });
      } catch {
        // a field that cannot be filled (hidden by a script, read-only...) does not stop the others
      }
    }
    if (action.submitRef) await this.page.locator(`[data-qa-ref="${action.submitRef}"]`).first().click({ timeout: 4000 });
    else await form.evaluate((f) => (f as HTMLFormElement).requestSubmit());
  }

  /** Waits for the page to react: a navigation, a script, a frame being loaded. */
  private async settle(): Promise<void> {
    await sleep(250);
    await this.page.waitForLoadState("load", { timeout: 4000 }).catch(() => undefined);
    await this.idleNetwork(150, 2500);
    await sleep(60);
  }

  /** What the page said about a problem: the browser's own validation text and visible alerts. */
  private async messages(includeInvalidFields: boolean): Promise<string[]> {
    const out = (await this.page
      .evaluate(
        `((withInvalid) => {
          const out = [];
          if (withInvalid) for (const el of document.querySelectorAll('input:invalid, select:invalid, textarea:invalid')) {
            const m = (el.validationMessage || '').trim();
            if (m) out.push(((el.getAttribute('aria-label') || el.name || 'campo') + ': ' + m).slice(0, 160));
          }
          for (const el of document.querySelectorAll('[role=alert], [aria-live=assertive], .alert, .flash, .notice, .error, .errors, .invalid-feedback, .field_with_errors')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) out.push(t.slice(0, 160));
          }
          return out.slice(0, 6);
        })(${includeInvalidFields})`,
      )
      .catch(() => [])) as string[];
    return [...new Set(out)];
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

const stripHash = (u: string): string => u.split("#")[0] ?? u;
const isHttp = (u: string): boolean => u.startsWith("http://") || u.startsWith("https://");
