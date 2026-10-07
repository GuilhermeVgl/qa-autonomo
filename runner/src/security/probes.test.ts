import { describe, expect, it } from "vitest";
import {
  EVIL_ORIGIN,
  benignUrl,
  candidatesOf,
  corsAcceptsAnyOrigin,
  evaluateProbe,
  exposedFile,
  injection,
  injectionUrl,
  isRedirectParam,
  redirectsOutside,
  REDIRECT_TARGET,
  SENSITIVE_FILES,
} from "./probes.js";
import type { PageFacts } from "./types.js";

const outcome = (over: Partial<{ status: number; injected: number[]; text: string }> = {}) => ({ status: 200, finalUrl: "https://app.test/search", injected: [], text: "Resultados", ...over });

describe("the injected value", () => {
  it("closes quotes and tags and leaves a marker no page has, one per parameter", () => {
    expect(injection(0)).toBe(`"'><qaxss0>`);
    expect(injection(2)).toBe(`"'><qaxss2>`);
  });

  it("is put into each parameter of an address that has no query yet", () => {
    const u = new URL(injectionUrl("https://app.test/search", ["q", "name"]));
    expect(u.searchParams.get("q")).toBe(injection(0));
    expect(u.searchParams.get("name")).toBe(injection(1));
    expect(new URL(benignUrl("https://app.test/search", ["q", "name"])).searchParams.get("q")).toBe("1");
  });
});

describe("evaluateProbe", () => {
  it("names the parameters whose marker became markup", () => {
    expect(evaluateProbe(outcome({ injected: [1] }), ["q", "name"]).xss).toEqual(["name"]);
    expect(evaluateProbe(outcome({ injected: [0, 1] }), ["q", "name"]).xss).toEqual(["q", "name"]);
    expect(evaluateProbe(outcome(), ["q"]).xss).toEqual([]);
  });

  it("ignores an index that is not a parameter it sent", () => {
    expect(evaluateProbe(outcome({ injected: [7] }), ["q"]).xss).toEqual([]);
  });

  it("sees a database error the page shows after the injection", () => {
    expect(evaluateProbe(outcome({ text: "You have an error in your SQL syntax near '\"\\'><qaxss0>'" }), ["q"]).sql).toBe("MySQL");
    expect(evaluateProbe(outcome(), ["q"]).sql).toBeNull();
  });

  it("does not blame the injection for an error the page shows anyway", () => {
    const text = "SQLSTATE[42000]: Syntax error";
    expect(evaluateProbe(outcome({ text }), ["q"], outcome({ text })).sql).toBeNull();
    expect(evaluateProbe(outcome({ text }), ["q"], outcome()).sql).toBe("PDO");
  });

  it("notes a server error that only the injection causes", () => {
    expect(evaluateProbe(outcome({ status: 500 }), ["q"], outcome()).serverError).toBe(true);
    expect(evaluateProbe(outcome({ status: 500 }), ["q"], outcome({ status: 500 })).serverError).toBe(false);
    expect(evaluateProbe(outcome({ status: 200 }), ["q"], outcome()).serverError).toBe(false);
    expect(evaluateProbe(outcome({ status: 500 }), ["q"]).serverError).toBe(false); // no baseline, no verdict
  });

  it("a database error is the better explanation of a server error", () => {
    const r = evaluateProbe(outcome({ status: 500, text: "ORA-00933: SQL command not properly ended" }), ["q"], outcome());
    expect(r.sql).toBe("Oracle");
    expect(r.serverError).toBe(false);
  });
});

describe("candidatesOf", () => {
  const facts = (forms: PageFacts["forms"]): PageFacts => ({ headers: {}, html: true, forms, metaCsrf: false, mixed: [], text: "", });
  const get = (action: string, names: string[], label = "Buscar") => ({ method: "GET", action, label, hidden: [], fields: names.map((name) => ({ name, type: "text" })), password: false });

  it("takes the parameters of the address the page was found at", () => {
    const c = candidatesOf({ url: "https://app.test/orders?page=2&q=x" });
    expect(c).toEqual([{ url: "https://app.test/orders", params: ["page", "q"], key: "/orders?page,q" }]);
  });

  it("takes the free-text fields of a GET form, resolved against the page, and nothing else", () => {
    const form = { ...get("https://app.test/search", ["term"]), fields: [{ name: "term", type: "text" }, { name: "n", type: "number" }, { name: "go", type: "submit" }, { name: "t", type: "hidden" }, { name: "p", type: "password" }, { name: "e", type: "email" }] };
    const c = candidatesOf({ url: "https://app.test/orders", security: facts([form]) });
    expect(c).toEqual([{ url: "https://app.test/search", params: ["term", "e"], key: "/search?e,term" }]);
  });

  it("leaves out forms that change data, that go to another site, that carry a password or that delete", () => {
    const post = { ...get("https://app.test/orders", ["name"]), method: "POST" };
    const elsewhere = get("https://other.example/s", ["q"]);
    const password = { ...get("https://app.test/login", ["user"]), password: true };
    const destructive = get("https://app.test/orders/delete", ["q"], "Excluir pedido");
    const logout = get("https://app.test/logout", ["q"], "Sair");
    expect(candidatesOf({ url: "https://app.test/orders", security: facts([post, elsewhere, password, destructive, logout]) })).toEqual([]);
  });

  it("is the same candidate however many pages show it, so each is tried once", () => {
    const a = candidatesOf({ url: "https://app.test/orders/1?q=a" })[0];
    const b = candidatesOf({ url: "https://app.test/orders/2?q=b" })[0];
    expect(a?.key).toBe(b?.key);
  });

  it("is nothing for a page without parameters or forms, or an address that is not valid", () => {
    expect(candidatesOf({ url: "https://app.test/orders" })).toEqual([]);
    expect(candidatesOf({ url: "not a url" })).toEqual([]);
  });

  it("limits how many parameters it takes from one place", () => {
    const c = candidatesOf({ url: "https://app.test/x?a=1&b=1&c=1&d=1&e=1&f=1&g=1" });
    expect(c[0]?.params).toHaveLength(5);
  });
});

describe("open redirect", () => {
  it("knows the parameters that tell an application where to go next", () => {
    for (const p of ["next", "url", "redirect", "redirect_uri", "return_to", "returnUrl", "continue", "dest", "destination", "goto"]) expect(isRedirectParam(p), p).toBe(true);
    for (const p of ["q", "page", "name", "id", "nextPage"]) expect(isRedirectParam(p), p).toBe(false);
  });

  it("is sent outside when the redirect points at the address we offered", () => {
    expect(redirectsOutside({ status: 302, headers: { location: REDIRECT_TARGET }, body: "" })).toBe(true);
    expect(redirectsOutside({ status: 301, headers: { location: "https://qa-redirect-check.invalid/other" }, body: "" })).toBe(true);
    expect(redirectsOutside({ status: 302, headers: { location: "//qa-redirect-check.invalid/qa" }, body: "" })).toBe(true);
    expect(redirectsOutside({ status: 302, headers: { location: "/orders" }, body: "" })).toBe(false);
    expect(redirectsOutside({ status: 200, headers: { location: REDIRECT_TARGET }, body: "" })).toBe(false);
    expect(redirectsOutside({ status: 302, headers: {}, body: "" })).toBe(false);
  });
});

describe("cors", () => {
  it("is open when an origin we made up is accepted together with credentials", () => {
    expect(corsAcceptsAnyOrigin({ status: 200, headers: { "access-control-allow-origin": EVIL_ORIGIN, "access-control-allow-credentials": "true" }, body: "" })).toBe(true);
    expect(corsAcceptsAnyOrigin({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" }, body: "" })).toBe(true);
    expect(corsAcceptsAnyOrigin({ status: 200, headers: { "access-control-allow-origin": EVIL_ORIGIN }, body: "" })).toBe(false); // no credentials: public data
    expect(corsAcceptsAnyOrigin({ status: 200, headers: { "access-control-allow-origin": "https://app.test", "access-control-allow-credentials": "true" }, body: "" })).toBe(false);
    expect(corsAcceptsAnyOrigin({ status: 200, headers: {}, body: "" })).toBe(false);
  });
});

describe("exposed files", () => {
  const resp = (status: number, body: string, contentType = "text/plain") => ({ status, headers: { "content-type": contentType }, body });
  const file = (path: string) => SENSITIVE_FILES.find((f) => f.path === path) as (typeof SENSITIVE_FILES)[number];

  it("recognizes each file by what is inside, not by the status", () => {
    expect(exposedFile(file("/.git/HEAD"), resp(200, "ref: refs/heads/main\n"))).toBe(true);
    expect(exposedFile(file("/.env"), resp(200, "APP_ENV=production\nDB_PASSWORD=secret\n"))).toBe(true);
    expect(exposedFile(file("/phpinfo.php"), resp(200, "<title>phpinfo()</title> PHP Version 7.4", "text/html"))).toBe(true);
    expect(exposedFile(file("/actuator/env"), resp(200, '{"activeProfiles":[],"propertySources":[]}', "application/json"))).toBe(true);
  });

  it("is not fooled by an application that answers every address with its home page", () => {
    const spa = resp(200, "<!doctype html><html><body><div id=app></div></body></html>", "text/html");
    for (const f of SENSITIVE_FILES) expect(exposedFile(f, spa), f.path).toBe(false);
    expect(exposedFile(file("/.env"), resp(404, "APP_ENV=production"))).toBe(false);
    expect(exposedFile(file("/.git/HEAD"), resp(200, "<html>ref: refs/heads/x</html>", "text/html"))).toBe(false);
  });

  it("says how serious each is", () => {
    expect(file("/.env").severity).toBe("critical");
    expect(file("/.git/HEAD").severity).toBe("critical");
    expect(file("/server-status").severity).toBe("high");
  });
});
