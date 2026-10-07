// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { detectSoftError } from "./softerror.js";

const read = (html: string, title = "") => {
  document.title = title;
  document.body.innerHTML = html;
  return detectSoftError(document);
};

describe("detectSoftError", () => {
  it("recognizes the usual error screens, in English and Portuguese", () => {
    expect(read("<h1>Internal Server Error</h1><p>The server encountered an error.</p>")).toContain("Internal Server Error");
    expect(read("<main><h1>Something went wrong</h1><a href='/'>Home</a></main>")).toContain("Something went wrong");
    expect(read("<h1>Erro interno do servidor</h1>")).toContain("Erro interno");
    expect(read("<div><h2>Ops! Algo deu errado.</h2></div>")).toContain("Algo deu errado");
    expect(read("<h1>404</h1><p>Página não encontrada</p>")).toContain("não encontrada");
    expect(read("<h1>Page not found</h1>")).toContain("Page not found");
  });

  it("uses the title when the page body says little", () => {
    expect(read("<p>Please try again later.</p>", "500 Internal Server Error")).toContain("Internal Server Error");
  });

  it("leaves normal pages alone, even those that talk about errors", () => {
    expect(read("<h1>Clientes</h1><table><tr><td>Ana</td></tr></table>")).toBeNull();
    // a long page that happens to mention an error in its content is not an error screen
    expect(read(`<h1>Guia</h1><p>${"Texto de ajuda. ".repeat(80)} Se algo deu errado, ligue para o suporte.</p>`)).toBeNull();
    expect(read("<h1>Relatório de erros do mês</h1><p>12 ocorrências</p>")).toBeNull();
  });

  it("never flags a page with a form (a login that failed says so, and is still a login)", () => {
    expect(read("<h1>Entrar</h1><p>Algo deu errado. Tente de novo.</p><form action='/s' method='post'><input name='u'></form>")).toBeNull();
  });

  it("works inside a real layout: a menu and a logout form around the error do not hide it", () => {
    const nav = `<nav>${"<a href='/x'>Menu item</a> ".repeat(40)}<form action="/logout" method="post"><button>Sair</button></form></nav>`;
    expect(read(`${nav}<main><h1>Something went wrong</h1><p>We are looking into it.</p></main>`)).toContain("Something went wrong");
  });

  it("a page with a search or login form is not an error screen, even when it says something went wrong", () => {
    expect(read("<main><h1>Algo deu errado</h1><form action='/s'><input type='search' name='q'></form></main>")).toBeNull();
  });

  it("returns a short text, never the whole page", () => {
    const text = read("<h1>Internal Server Error</h1><p>" + "x ".repeat(100) + "</p>") ?? "";
    expect(text.length).toBeLessThanOrEqual(200);
  });
});
