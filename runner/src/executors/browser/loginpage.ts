export interface LoginPage {
  /** A password field is on the page: this is where to log in. */
  hasPassword: boolean;
  /** No password yet, but the page asks only for the user and has a button to go on (the first step of a two-step login). */
  firstStep: boolean;
  /** Where a page without a login form hides it: a link or button that says "Entrar", "Login", "Sign in"... */
  loginLink: { href: string; text: string } | null;
  /** Something a robot cannot get past: a captcha or a one-time code. */
  blocker: "captcha" | "otp" | null;
  /** What the page says about a failed attempt ("E-mail ou senha inválidos"). */
  message: string;
}

/**
 * Reads a page as a login page: which field is the user, which is the password, which button sends it, and what stands in
 * the way. It tags what it found with `data-qa-login` (user, pass, submit, next, link) so the browser can act on it.
 * Self-contained on purpose: Playwright serializes it into the page via `page.evaluate`, and the tests run it under jsdom
 * with `assumeVisible` (jsdom has no layout).
 */
export function analyzeLoginPage(doc: Document, pageUrl: string, assumeVisible: boolean): LoginPage {
  for (const el of Array.from(doc.querySelectorAll("[data-qa-login]"))) el.removeAttribute("data-qa-login");
  const clean = (s: string | null | undefined, max: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const visible = (el: Element): boolean => {
    if (assumeVisible) return true;
    const style = doc.defaultView?.getComputedStyle(el);
    return el.getClientRects().length > 0 && style?.visibility !== "hidden";
  };
  const tag = (el: Element, name: string): void => el.setAttribute("data-qa-login", name);

  const inputs = (Array.from(doc.querySelectorAll("input")) as HTMLInputElement[]).filter((i) => i.type !== "hidden" && !i.disabled && !i.readOnly && visible(i));
  const passwords = inputs.filter((i) => i.type === "password");
  const textOf = (i: HTMLInputElement): string => {
    const label = i.labels && i.labels.length > 0 ? i.labels[0]?.textContent : "";
    return [i.name, i.id, i.placeholder, i.getAttribute("aria-label"), i.autocomplete, label].join(" ").toLowerCase();
  };
  const USERISH = /user|login|e-?mail|cpf|cnpj|usu[aá]rio|matr[ií]cula|conta|account|identif|ident\b|acesso/;
  const SEARCHISH = /search|busca|pesquis|(^|\s)q(\s|$)/;
  const TEXTUAL = new Set(["text", "email", "tel", "number", "url"]);

  /** The part of the page the password belongs to: its form, or the smallest box around it that holds no other password. */
  const containerOf = (pw: HTMLInputElement): Element => {
    const form = pw.closest("form");
    if (form) return form;
    let c: Element = pw.parentElement ?? doc.body;
    while (c.parentElement && c.parentElement !== doc.body && c.parentElement.querySelectorAll("input[type=password]").length === 1 && c.parentElement.querySelectorAll("input").length <= 6) c = c.parentElement;
    return c;
  };

  const userFieldIn = (scope: Element, before?: Element): HTMLInputElement | null => {
    const cands = inputs.filter((i) => scope.contains(i) && TEXTUAL.has(i.type));
    let best: HTMLInputElement | null = null;
    let bestScore = -Infinity;
    cands.forEach((i, idx) => {
      const t = textOf(i);
      let score = 0;
      if (/username|email/.test(i.autocomplete.toLowerCase())) score += 5;
      if (USERISH.test(t)) score += 3;
      if (i.type === "email") score += 2;
      if (SEARCHISH.test(t)) score -= 4;
      // the one just before the password is the likely one: the order of a login form is user, then password
      if (before && (i.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) score += 1 + idx / 100;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best;
  };

  const buttonsIn = (scope: Element): HTMLElement[] =>
    (Array.from(scope.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")) as HTMLElement[]).filter((b) => visible(b) && !(b as HTMLButtonElement).disabled);
  const labelOf = (b: Element): string => clean(b.getAttribute("aria-label") || b.textContent || b.getAttribute("value") || b.getAttribute("title"), 60);
  const pickButton = (scope: Element, words: RegExp): HTMLElement | null => {
    const all = buttonsIn(scope);
    return all.find((b) => (b as HTMLButtonElement).type === "submit" && words.test(labelOf(b).toLowerCase())) ?? all.find((b) => words.test(labelOf(b).toLowerCase())) ?? all.find((b) => (b as HTMLButtonElement).type === "submit") ?? all[0] ?? null;
  };

  let firstStep = false;
  let loginLink: LoginPage["loginLink"] = null;
  if (passwords.length > 0) {
    // a registration form has two passwords: the one with exactly one is the login
    const chosen = passwords.find((p) => containerOf(p).querySelectorAll("input[type=password]").length === 1) ?? passwords[0];
    if (chosen) {
      const scope = containerOf(chosen);
      tag(chosen, "pass");
      const user = userFieldIn(scope, chosen);
      if (user) tag(user, "user");
      const submit = pickButton(scope, /entrar|login|log ?in|sign ?in|acessar|continuar|enviar|submit|\bok\b|\bgo\b/);
      if (submit) tag(submit, "submit");
    }
  } else {
    const where = `${new URL(pageUrl, "https://x.invalid").pathname} ${doc.title} ${clean(doc.querySelector("h1,h2")?.textContent, 80)}`.toLowerCase();
    const loginish = /login|entrar|sign.?in|acesso|autentic|identific|conectar/.test(where);
    const user = loginish ? userFieldIn(doc.body) : null;
    if (user && (USERISH.test(textOf(user)) || /username|email/.test(user.autocomplete.toLowerCase()) || user.type === "email")) {
      const next = pickButton(user.closest("form") ?? doc.body, /pr[oó]ximo|continuar|avan[cç]ar|next|continue|seguinte|entrar/);
      if (next) {
        firstStep = true;
        tag(user, "user");
        tag(next, "next");
      }
    }
    if (!firstStep) {
      let bestScore = 0;
      for (const el of Array.from(doc.querySelectorAll("a[href], button, [role=button], input[type=button]")) as HTMLElement[]) {
        if (!visible(el)) continue;
        const text = labelOf(el);
        const lower = text.toLowerCase();
        if (!/\b(entrar|login|log ?in|sign ?in|acessar|acesso|fazer login|autenticar)\b/.test(lower) || /cadastr|criar|sign ?up|registr|esqueci|forgot|recuper|reset|nova conta/.test(lower)) continue;
        const raw = el.tagName === "A" ? (el.getAttribute("href") ?? "") : "";
        if (el.tagName === "A" && (raw === "" || raw.startsWith("#") || /^(javascript|mailto|tel):/i.test(raw))) continue;
        let href = "";
        if (raw) {
          try {
            href = new URL(raw, pageUrl).toString();
          } catch {
            continue;
          }
        }
        const score = 1 + (/login|signin|sign_in|entrar|auth|session/i.test(raw) ? 3 : 0) + (/^(entrar|login|sign in|acessar)$/.test(lower) ? 2 : 0);
        if (score > bestScore) {
          bestScore = score;
          loginLink = { href, text };
          for (const t of Array.from(doc.querySelectorAll('[data-qa-login="link"]'))) t.removeAttribute("data-qa-login");
          tag(el, "link");
        }
      }
    }
  }

  const bodyText = doc.body?.textContent ?? "";
  const captcha =
    doc.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]') !== null ||
    /n[ãa]o sou um rob[ôo]|n[ãa]o [ée] um rob[ôo]|not a robot|captcha/i.test(bodyText);
  // the field a one-time code goes in, so a TOTP secret can be filled in; a registration/login form is not an OTP step
  const otpField =
    passwords.length > 0
      ? null
      : (inputs.find((i) => i.autocomplete.toLowerCase() === "one-time-code") ??
        inputs.find((i) => TEXTUAL.has(i.type) && i.maxLength > 0 && i.maxLength <= 8 && /otp|totp|2fa|c[óo]digo|code|token|verifica/.test(textOf(i))) ??
        null);
  if (otpField) {
    tag(otpField, "otp");
    const submit = pickButton(otpField.closest("form") ?? doc.body, /verificar|confirmar|continuar|entrar|validar|verify|confirm|continue|submit|\bok\b/);
    if (submit) tag(submit, "submit");
  }
  const otp = otpField !== null;

  let message = "";
  for (const el of Array.from(doc.querySelectorAll('[role=alert], [aria-live=assertive], .alert, .error, .errors, .invalid-feedback, .flash, .notice, .text-danger, [class*="error"], [class*="erro"]'))) {
    const t = clean(el.textContent, 160);
    if (t && visible(el)) {
      message = t;
      break;
    }
  }
  return { hasPassword: passwords.length > 0, firstStep, loginLink, blocker: captcha ? "captcha" : otp ? "otp" : null, message };
}
