// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectPageFacts } from "./pagefacts.js";

const read = (html: string, url = "https://app.test/orders", title = "Pedidos") => {
  document.title = title;
  document.body.innerHTML = html;
  return collectPageFacts(document, url);
};

describe("collectPageFacts", () => {
  it("lists forms by where they send, the names of their fields and the hidden ones, never a value", () => {
    const f = read(`
      <form action="/orders" method="post" aria-label="Novo pedido">
        <input type="hidden" name="authenticity_token" value="SECRET-TOKEN">
        <input name="order[name]" value="typed by a person"><textarea name="order[note]"></textarea>
        <select name="order[kind]"></select><button type="submit">Salvar</button>
      </form>
      <form action="/search"><input type="search" name="q"><button>Buscar</button></form>`);
    expect(f.forms).toEqual([
      {
        method: "POST",
        action: "https://app.test/orders",
        label: "Novo pedido",
        hidden: ["authenticity_token"],
        fields: [{ name: "authenticity_token", type: "hidden" }, { name: "order[name]", type: "text" }, { name: "order[note]", type: "textarea" }, { name: "order[kind]", type: "select" }],
        password: false,
      },
      { method: "GET", action: "https://app.test/search", label: "Buscar", hidden: [], fields: [{ name: "q", type: "search" }], password: false },
    ]);
    expect(JSON.stringify(f)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(f)).not.toContain("typed by a person");
  });

  it("takes the verb a Rails form really means, and marks a password form", () => {
    const f = read(`<form action="/orders/1" method="post"><input type="hidden" name="_method" value="delete"><button>Remover</button></form>
                    <form action="/session" method="post"><input name="email"><input type="password" name="password"></form>`);
    expect(f.forms[0]?.method).toBe("DELETE");
    expect(f.forms[1]?.password).toBe(true);
  });

  it("resolves an action against the page, and a form without one posts to the page", () => {
    const f = read(`<form method="post"><input name="a"></form><form action="../x" method="post"><input name="b"></form>`, "https://app.test/a/b/c");
    expect(f.forms.map((x) => x.action)).toEqual(["https://app.test/a/b/c", "https://app.test/a/x"]);
  });

  it("sees the csrf meta tag", () => {
    document.head.innerHTML = '<meta name="csrf-token" content="x">';
    expect(read("<p>x</p>").metaCsrf).toBe(true);
    document.head.innerHTML = "";
    expect(read("<p>x</p>").metaCsrf).toBe(false);
  });

  it("lists what an https page loads over plain http, and only on an https page", () => {
    const html = `<script src="http://cdn.test/a.js"></script><img src="https://cdn.test/ok.png"><link rel="stylesheet" href="http://cdn.test/a.css">`;
    expect(read(html).mixed).toEqual(["http://cdn.test/a.js", "http://cdn.test/a.css"]);
    expect(read(html, "http://app.test/orders").mixed).toEqual([]);
  });

  it("gives the title and the visible text, cut", () => {
    const f = read(`<h1>Index of /backups</h1><p>${"x".repeat(30_000)}</p>`, "https://app.test/", "Index of /backups");
    expect(f.text.startsWith("Index of /backups")).toBe(true);
    expect(f.text.length).toBeLessThanOrEqual(20_000);
  });
});
