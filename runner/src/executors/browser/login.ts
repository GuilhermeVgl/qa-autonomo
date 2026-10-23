import type { Page } from "playwright";
import type { LoginFailure } from "../../agent/explorer.js";
import { isGatewayStatus, isInfraMessage } from "../../agent/health.js";
import { analyzeLoginPage, type LoginPage } from "./loginpage.js";
import { totpCode } from "./totp.js";

export type LoginOutcome = { ok: true } | ({ ok: false } & LoginFailure);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Where applications usually keep their login, tried only when the home page shows no way in. */
const COMMON_PATHS = ["/login", "/signin", "/users/sign_in", "/entrar", "/auth/login", "/session/new", "/account/login", "/admin/login"];

const fail = (reason: LoginFailure["reason"], message: string): LoginOutcome => ({ ok: false, reason, message });

export interface LoginContext {
  /** Hosts the scope guard has refused so far: a login that goes through one of them is single sign-on. */
  blockedHosts: () => string[];
}

/**
 * Logs in the way a person would, on applications nobody told the runner about: finds the login form (on the page, behind an
 * "Entrar" link or button, or at one of the usual addresses), handles a first step that asks only for the user, fills it
 * with the credentials, sends it by Enter and by the button, and judges the result by what the page shows: the password
 * field gone is a login, the field still there with a message is a refusal. When it cannot, it says why.
 */
export async function performLogin(page: Page, baseUrl: string, payload: Record<string, string>, ctx: LoginContext): Promise<LoginOutcome> {
  const blockedBefore = new Set(ctx.blockedHosts());
  const newlyBlocked = (): string[] => ctx.blockedHosts().filter((h) => !blockedBefore.has(h));
  const analyze = async (): Promise<LoginPage> => {
    // a page that is navigating cannot be read for a moment: ask again
    for (let i = 0; ; i++) {
      try {
        return (await page.evaluate(`(${analyzeLoginPage.toString()})(document, location.href, false)`)) as LoginPage;
      } catch (err) {
        if (i >= 5) throw err;
        await sleep(200);
      }
    }
  };
  const settle = async (): Promise<void> => {
    await page.waitForLoadState("load").catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
    await sleep(150);
  };
  const go = async (url: string): Promise<{ status: number } | { error: string }> => {
    try {
      const res = await page.goto(url, { waitUntil: "load" });
      await settle();
      return { status: res?.status() ?? 0 };
    } catch (err) {
      return { error: err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err) };
    }
  };
  const ssoHint = (): string => {
    const hosts = [...new Set(newlyBlocked())];
    return hosts.length > 0
      ? ` O login passa por ${hosts.join(", ")}, fora dos hosts permitidos do ambiente (login único/SSO). Para entrar, capture uma sessão autenticada (credencial do tipo "sessão", com \`npm run capture\`), que funciona com qualquer SSO/2FA/captcha; ou, se for um provedor simples de usuário e senha, adicione esse(s) host(s) aos hosts permitidos.`
      : "";
  };

  try {
    const first = await go(baseUrl);
    if ("error" in first) return isInfraMessage(first.error) ? fail("unreachable", `a aplicação não abriu: ${first.error}`) : fail("error", first.error);
    if (isGatewayStatus(first.status)) return fail("unreachable", `a aplicação respondeu HTTP ${first.status}`);

    let a = await analyze();
    const followed = new Set<string>();
    // 1) find the form: a first step, or a link or button that leads to the login
    for (let hop = 0; hop < 3 && !a.hasPassword && !a.blocker; hop++) {
      if (a.firstStep) {
        await page.locator('[data-qa-login="user"]').first().fill(payload["username"] ?? "");
        await page.locator('[data-qa-login="next"]').first().click({ timeout: 4000 }).catch(() => page.keyboard.press("Enter"));
        for (let i = 0; i < 30 && !(a = await analyze()).hasPassword && !a.blocker; i++) await sleep(200);
        continue;
      }
      const link = a.loginLink;
      if (!link || followed.has(link.href + "|" + link.text)) break;
      followed.add(link.href + "|" + link.text);
      if (link.href) {
        const r = await go(link.href);
        if ("error" in r && newlyBlocked().length > 0) return fail("sso_blocked", `o link "${link.text}" leva para outro site.${ssoHint()}`);
      } else {
        await page.locator('[data-qa-login="link"]').first().click({ timeout: 4000 }).catch(() => undefined);
        await settle();
      }
      a = await analyze();
    }
    // 2) nothing on the page led to a login: try the addresses applications usually use
    if (!a.hasPassword && !a.blocker) {
      const origin = new URL(baseUrl).origin;
      for (const path of COMMON_PATHS) {
        const r = await go(origin + path);
        if ("status" in r && r.status < 400) {
          a = await analyze();
          if (a.hasPassword || a.blocker) break;
        }
      }
    }
    if (a.blocker && !a.hasPassword) return fail("needs_more", a.blocker === "captcha" ? "a tela de login pede captcha, que o agente não resolve" : "a tela pede um código de verificação (2FA), que o agente não consegue informar");
    if (!a.hasPassword) return fail("no_form", `não achei a tela de login a partir de ${baseUrl}: sem campo de senha, sem link "Entrar" e nos endereços de login comuns.${ssoHint()}`);
    if (a.blocker === "captcha") return fail("needs_more", "a tela de login pede captcha, que o agente não resolve");

    // 3) fill it and send it
    const user = page.locator('[data-qa-login="user"]').first();
    if ((await user.count()) > 0) await user.fill(payload["username"] ?? "");
    const pass = page.locator('[data-qa-login="pass"]').first();
    await pass.fill(payload["password"] ?? "");
    const submit = page.locator('[data-qa-login="submit"]').first();
    const hasSubmit = (await submit.count()) > 0;

    const passwordGone = async (ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        try {
          const shown = (await page.evaluate(`[...document.querySelectorAll("input[type=password]")].some((i) => i.getClientRects().length > 0 && getComputedStyle(i).visibility !== "hidden")`)) as boolean;
          if (!shown) return true;
        } catch {
          return true; // the page was swapped under us: it moved on
        }
        await sleep(150);
      }
      return false;
    };
    // an answer of the server to what was sent: a refusal is often a 401 page with no form to see
    let refusedWith = 0;
    const onResponse = (res: { request(): { resourceType(): string; isNavigationRequest(): boolean }; status(): number }): void => {
      if (res.request().isNavigationRequest() && res.request().resourceType() === "document" && res.status() >= 400) refusedWith = res.status();
      else if (res.request().isNavigationRequest() && res.status() < 400) refusedWith = 0;
    };
    page.on("response", onResponse);
    await pass.press("Enter");
    let done = await passwordGone(hasSubmit ? 3500 : 8000);
    if (!done && hasSubmit) {
      // a form handled by a script often does not answer to Enter: press the button as a person would
      await submit.click({ timeout: 4000, force: true }).catch(() => undefined);
      done = await passwordGone(8000);
    }
    await settle();
    page.off("response", onResponse);
    const after = await analyze().catch(() => undefined);
    if (done && refusedWith >= 400 && !after?.hasPassword) {
      const said = after?.message ? ` A tela diz: "${after.message.replace(/\.$/, "")}".` : "";
      return fail("rejected", `o login não foi aceito: o servidor respondeu HTTP ${refusedWith}.${said}`);
    }
    if (!done || after?.hasPassword) {
      const said = after?.message ? ` A tela diz: "${after.message.replace(/\.$/, "")}".` : "";
      return newlyBlocked().length > 0 ? fail("sso_blocked", `o login não completou.${ssoHint()}`) : fail("rejected", `o login não foi aceito: a tela de login continua aberta.${said}`);
    }
    if (after?.blocker === "otp" && payload["totp_secret"]) {
      const otpResult = await passTotp(page, payload["totp_secret"], settle, analyze);
      if (otpResult !== "ok") {
        const said = otpResult.message ? ` A tela diz: "${otpResult.message.replace(/\.$/, "")}".` : "";
        return otpResult.kind === "needs_more" ? fail("needs_more", `${otpResult.reason}${said}`) : fail("rejected", `o código de verificação (2FA) não foi aceito.${said}`);
      }
      return { ok: true };
    }
    if (after?.blocker) return fail("needs_more", after.blocker === "captcha" ? "o login pede captcha, que o agente não resolve" : "o login pede um código de verificação (2FA), que o agente não consegue informar");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
    return isInfraMessage(message) ? fail("unreachable", `a aplicação não respondeu durante o login: ${message}`) : fail("error", `erro ao tentar o login: ${message}`);
  }
}

type TotpResult = "ok" | { kind: "needs_more" | "rejected"; reason: string; message: string };

/** Fills a two-factor code from a TOTP secret (RFC 6238): works with any authenticator-app provider, never SMS/push. */
async function passTotp(page: Page, secret: string, settle: () => Promise<void>, analyze: () => Promise<LoginPage>): Promise<TotpResult> {
  const field = page.locator('[data-qa-login="otp"]').first();
  if ((await field.count()) === 0) return { kind: "needs_more", reason: "a tela pede um código de verificação (2FA) que o agente não conseguiu localizar", message: "" };
  let code: string;
  try {
    code = totpCode(secret);
  } catch {
    return { kind: "needs_more", reason: "o segredo TOTP informado é inválido (esperado base32)", message: "" };
  }
  await field.fill(code);
  const submit = page.locator('[data-qa-login="submit"]').first();
  await field.press("Enter");
  const hasSubmit = (await submit.count()) > 0;
  // re-read until the code step is gone (success) or it stays with a message (rejected)
  const until = (ms: number): Promise<LoginPage | undefined> => {
    const deadline = Date.now() + ms;
    return (async () => {
      let last: LoginPage | undefined;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 200));
        last = await analyze().catch(() => undefined);
        if (last && last.blocker !== "otp" && !last.hasPassword) return last;
      }
      return last;
    })();
  };
  let after = await until(4000);
  if ((after?.blocker === "otp" || after === undefined) && hasSubmit) {
    await submit.click({ timeout: 4000, force: true }).catch(() => undefined);
    after = await until(6000);
  }
  await settle();
  const final = (await analyze().catch(() => undefined)) ?? after;
  if (final?.hasPassword) return { kind: "rejected", reason: "", message: final.message };
  if (final?.blocker === "otp") return { kind: "rejected", reason: "", message: final.message };
  if (final?.blocker === "captcha") return { kind: "needs_more", reason: "o login pede captcha, que o agente não resolve", message: "" };
  return "ok";
}
