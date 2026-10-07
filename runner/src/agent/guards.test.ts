import { describe, expect, it } from "vitest";
import { isAllowedUrl, isDestructive, shouldSkip } from "./guards.js";

describe("isAllowedUrl", () => {
  const hosts = ["app.example.com", "api.example.com"];
  it.each([
    ["https://app.example.com/x", true],
    ["http://API.example.com/y?z=1", true],
    ["https://evil.com/", false],
    ["https://app.example.com.evil.com/", false],
    ["https://evil.com/app.example.com", false],
    ["https://sub.app.example.com/", false],
    ["javascript:alert(1)", false],
    ["file:///etc/passwd", false],
    ["data:text/html,hi", false],
    ["not a url", false],
  ])("%s -> %s", (url, want) => {
    expect(isAllowedUrl(url, hosts)).toBe(want);
  });

  it("allows about:blank (browser internal)", () => {
    expect(isAllowedUrl("about:blank", hosts)).toBe(true);
  });
});

describe("isDestructive", () => {
  it.each([
    ["Delete order", "/orders/1/delete", true],
    ["Excluir pedido", "/pedidos/1", true],
    ["Remover", "#", true],
    ["Apagar conta", "/x", true],
    ["Sair", "/logout", true],
    ["View order", "/orders/1", false],
    ["Orders", "/orders", false],
    ["Undeleted items", "/archive", false],
  ])("%s %s -> %s", (label, href, want) => {
    expect(isDestructive({ label, href })).toBe(want);
  });
});

describe("shouldSkip", () => {
  const link = { label: "Delete", href: "/orders/1/delete" };
  it("block policy skips destructive actions", () => {
    expect(shouldSkip(link, "block")).toBe(true);
  });
  it("confirm policy also skips (no human in the loop during exploration)", () => {
    expect(shouldSkip(link, "confirm")).toBe(true);
  });
  it("allow policy lets it through", () => {
    expect(shouldSkip(link, "allow")).toBe(false);
  });
  it("never skips harmless actions", () => {
    expect(shouldSkip({ label: "Orders", href: "/orders" }, "block")).toBe(false);
  });
});
