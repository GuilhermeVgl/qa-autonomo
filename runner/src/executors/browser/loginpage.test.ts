// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { analyzeLoginPage } from "./loginpage.js";

const read = (html: string, url = "https://app.test/", title = "") => {
  document.title = title;
  document.body.innerHTML = html;
  return analyzeLoginPage(document, url, true);
};
const tagged = (name: string): string | null => document.querySelector(`[data-qa-login="${name}"]`)?.getAttribute("name") ?? document.querySelector(`[data-qa-login="${name}"]`)?.textContent?.trim() ?? null;

describe("analyzeLoginPage: a form with a password", () => {
  it("finds the user field, the password and the button of an ordinary form", () => {
    const a = read(`<form action="/session" method="post"><input name="authenticity_token" type="hidden"><input name="email" type="email"><input name="password" type="password"><button type="submit">Entrar</button></form>`);
    expect(a.hasPassword).toBe(true);
    expect(tagged("user")).toBe("email");
    expect(tagged("pass")).toBe("password");
    expect(tagged("submit")).toBe("Entrar");
  });

  it("does not take a search box before the form for the user field", () => {
    const a = read(`<header><input type="search" name="q" placeholder="Buscar"></header>
      <form><input type="text" name="cpf" placeholder="CPF"><input type="password" name="senha"><button>Acessar</button></form>`);
    expect(a.hasPassword).toBe(true);
    expect(tagged("user")).toBe("cpf");
  });

  it("prefers the field that says it is the user among several", () => {
    read(`<form><input name="empresa" type="text" placeholder="Empresa"><input name="usuario" type="text" placeholder="Usuário"><input name="senha" type="password"><button>OK</button></form>`);
    expect(tagged("user")).toBe("usuario");
  });

  it("falls back to the text field just before the password", () => {
    read(`<form><input name="field_a" type="text"><input name="field_b" type="text"><input name="field_c" type="password"><button>Go</button></form>`);
    expect(tagged("user")).toBe("field_b");
  });

  it("takes the form with one password over a registration form with two", () => {
    read(`<form id="signup"><input name="e" type="email"><input name="p1" type="password"><input name="p2" type="password"><button>Cadastrar</button></form>
          <form id="login"><input name="user" type="text"><input name="pw" type="password"><button>Entrar</button></form>`);
    expect(tagged("pass")).toBe("pw");
  });

  it("finds a submit button that is not a submit, and one that is a link-like div", () => {
    read(`<form><input name="u" type="text"><input name="p" type="password"><button type="button">Entrar</button></form>`);
    expect(tagged("submit")).toBe("Entrar");
  });

  it("finds a login form that is not inside a <form>", () => {
    const a = read(`<div class="box"><input name="u" type="text" placeholder="Usuário"><input name="p" type="password"><button>Login</button></div>`);
    expect(a.hasPassword).toBe(true);
    expect(tagged("user")).toBe("u");
    expect(tagged("submit")).toBe("Login");
  });
});

describe("analyzeLoginPage: no password on the page", () => {
  it("finds the way to a login page: a link that says so, not the ones about registering", () => {
    const a = read(`<nav><a href="/cadastro">Criar conta</a><a href="/esqueci">Esqueci a senha</a><a href="/entrar">Entrar</a></nav>`);
    expect(a.hasPassword).toBe(false);
    expect(a.loginLink).toEqual({ href: "https://app.test/entrar", text: "Entrar" });
  });

  it("prefers a link whose address says login over one whose text only does", () => {
    const a = read(`<a href="/portal">Acessar o portal</a><a href="/users/sign_in">Login</a>`);
    expect(a.loginLink?.href).toBe("https://app.test/users/sign_in");
  });

  it("offers a button too, when it is not a link", () => {
    const a = read(`<button type="button">Fazer login</button>`);
    expect(a.loginLink).toEqual({ href: "", text: "Fazer login" });
    expect(tagged("link")).toBe("Fazer login");
  });

  it("knows a first step that asks only for the user", () => {
    const a = read(`<form><input type="email" name="identifier" autocomplete="username"><button>Próximo</button></form>`, "https://app.test/login", "Entrar");
    expect(a.hasPassword).toBe(false);
    expect(a.firstStep).toBe(true);
    expect(tagged("user")).toBe("identifier");
    expect(tagged("next")).toBe("Próximo");
  });

  it("does not take an ordinary page with a search box for a first step", () => {
    const a = read(`<form><input type="search" name="q"><button>Buscar</button></form><h1>Pedidos</h1>`, "https://app.test/orders", "Pedidos");
    expect(a.firstStep).toBe(false);
    expect(a.loginLink).toBeNull();
  });
});

describe("analyzeLoginPage: what stands in the way", () => {
  it("sees a captcha", () => {
    expect(read(`<form><input type="text" name="u"><input type="password" name="p"><div class="g-recaptcha" data-sitekey="x"></div><button>Entrar</button></form>`).blocker).toBe("captcha");
    expect(read(`<form><input type="password" name="p"></form><p>Confirme que você não é um robô</p>`).blocker).toBe("captcha");
  });

  it("sees a second factor", () => {
    expect(read(`<form><input type="text" name="otp" autocomplete="one-time-code" maxlength="6"><button>Verificar</button></form>`).blocker).toBe("otp");
    expect(read(`<form><input type="text" name="codigo" maxlength="6" placeholder="Código de verificação"><button>Confirmar</button></form>`).blocker).toBe("otp");
  });

  it("tags the code field and its button so a TOTP secret can be filled in", () => {
    read(`<form><input name="code" autocomplete="one-time-code" maxlength="6"><button type="submit">Verificar</button></form>`);
    expect(tagged("otp")).toBe("code");
    expect(tagged("submit")).toBe("Verificar");
  });

  it("is not blocked on an ordinary login", () => {
    expect(read(`<form><input type="text" name="u"><input type="password" name="p"><button>Entrar</button></form>`).blocker).toBeNull();
  });

  it("reads the message the page shows about the failed attempt", () => {
    const a = read(`<form><input type="text" name="u"><input type="password" name="p"><button>Entrar</button></form><div role="alert">  E-mail ou senha   inválidos. </div>`);
    expect(a.message).toBe("E-mail ou senha inválidos.");
    expect(read(`<form><input type="password" name="p"></form><p class="error">Usuário bloqueado</p>`).message).toBe("Usuário bloqueado");
    expect(read(`<form><input type="password" name="p"></form>`).message).toBe("");
  });
});
