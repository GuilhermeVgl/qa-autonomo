// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectInventory } from "./inventory.js";

const page = (html: string) => {
  document.body.innerHTML = html;
  return collectInventory(document, true);
};

const HTML = `
<main><h1>Clientes</h1><h2>Lista</h2>
<form action="/clients" method="post" aria-label="Novo cliente">
  <input type="hidden" name="authenticity_token" value="secret">
  <label for="n">Nome</label><input id="n" name="client[name]" required maxlength="40">
  <input type="email" name="client[email]" placeholder="E-mail do cliente">
  <select name="client[area]"><option value="">Escolha</option><option value="civil">Civil</option><option value="penal">Penal</option></select>
  <input type="checkbox" name="client[active]">
  <button type="submit">Salvar</button>
</form>
<form action="/clients/1" method="post"><input type="hidden" name="_method" value="delete"><button type="submit">Remover</button></form>
<form action="/clients" method="get"><input type="search" name="q"><button>Buscar</button></form>
<form action="/session" method="post"><input type="email" name="email"><input type="password" name="password"><input type="file" name="doc"><button type="submit">Entrar</button></form>
<button type="button" aria-expanded="false">Mostrar mais</button>
<details><summary>Filtros</summary></details>
<button type="button" disabled>Inativo</button>
<div role="tab">Aba</div>
</main>`;

describe("collectInventory", () => {
  it("lists forms with their fields, labels and the verb they really mean", () => {
    const inv = page(HTML);
    expect(inv.headings).toEqual(["Clientes", "Lista"]);
    expect(inv.forms.map((f) => `${f.method} ${f.action}`)).toEqual(["POST /clients", "DELETE /clients/1", "GET /clients", "POST /session"]);
    const create = inv.forms[0];
    expect(create).toMatchObject({ label: "Novo cliente", submitLabel: "Salvar", hasFile: false, hasPassword: false });
    expect(create?.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["client[name]:text", "client[email]:email", "client[area]:select", "client[active]:checkbox"]);
    expect(create?.fields[0]).toMatchObject({ label: "Nome", required: true, maxlength: 40 });
    expect(create?.fields[1]?.label).toBe("E-mail do cliente");
    expect(create?.fields[2]?.options).toEqual(["civil", "penal"]);
    expect(inv.forms[3]).toMatchObject({ hasFile: true, hasPassword: true });
  });

  it("hides CSRF tokens and method overrides from the fields (the browser sends them by itself)", () => {
    const names = page(HTML).forms.flatMap((f) => f.fields.map((x) => x.name));
    expect(names).not.toContain("authenticity_token");
    expect(names).not.toContain("_method");
  });

  it("lists the buttons that are not the submit button of a form", () => {
    const inv = page(HTML);
    expect(inv.buttons.map((b) => `${b.kind}:${b.label}${b.disabled ? "!" : ""}`)).toEqual(["toggle:Mostrar mais", "summary:Filtros", "button:Inativo!", "tab:Aba"]);
  });

  it("marks controls that live in the reusable chrome (header/sidebar/nav), not the ones in the content", () => {
    const inv = page(`
      <header><button type="button">Trocar de organização</button></header>
      <nav><a href="/contratos">Contratos</a><form action="/busca" method="get"><input name="q"><button>Buscar</button></form></nav>
      <aside role="complementary"><button type="button">Ajuda</button></aside>
      <main>
        <button type="button">Novo contrato</button>
        <form action="/contratos" method="post"><input name="nome"><button type="submit">Salvar</button></form>
      </main>`);
    const chromeOf = (label: string) => inv.buttons.find((b) => b.label === label)?.chrome;
    expect(chromeOf("Trocar de organização")).toBe(true);
    expect(chromeOf("Ajuda")).toBe(true);
    expect(chromeOf("Novo contrato")).toBeUndefined();
    expect(inv.forms.find((f) => f.action === "/busca")?.chrome).toBe(true);
    expect(inv.forms.find((f) => f.action === "/contratos")?.chrome).toBeUndefined();
  });

  it("gives every element a stable handle the browser can find again", () => {
    const inv = page(HTML);
    const form = inv.forms[0];
    expect(document.querySelector(`[data-qa-ref="${form?.ref}"]`)?.tagName).toBe("FORM");
    expect(document.querySelector(`[data-qa-ref="${form?.fields[0]?.ref}"]`)?.getAttribute("name")).toBe("client[name]");
    expect(document.querySelector(`[data-qa-ref="${form?.submitRef}"]`)?.textContent).toBe("Salvar");
    const refs = [...document.querySelectorAll("[data-qa-ref]")].map((e) => e.getAttribute("data-qa-ref"));
    expect(new Set(refs).size).toBe(refs.length);
    // reading the page again starts the numbering over
    expect(collectInventory(document, true).forms[0]?.ref).toBe(form?.ref);
  });

  it("can read just one part of the page (a modal)", () => {
    document.body.innerHTML = `<main><form action="/a"><button>Fora</button></form><div id="m"><form action="/b" method="post"><input name="x"><button>Dentro</button></form></div></main>`;
    const inv = collectInventory(document.getElementById("m") as Element, true);
    expect(inv.forms.map((f) => f.action)).toEqual(["/b"]);
  });

  it("is bounded", () => {
    const many = Array.from({ length: 80 }, (_, i) => `<button type="button">b${i}</button>`).join("");
    expect(page(`<main>${many}</main>`).buttons).toHaveLength(40);
  });
});
