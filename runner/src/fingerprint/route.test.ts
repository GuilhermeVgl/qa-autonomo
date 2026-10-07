import { describe, expect, it } from "vitest";
import { routePattern } from "./route.js";

describe("routePattern", () => {
  it.each([
    ["https://a.com/orders/123", "/orders/:id"],
    ["https://a.com/orders/123/items/9", "/orders/:id/items/:id"],
    ["https://a.com/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301", "/users/:id"],
    ["https://a.com/files/9b2f4c1ad8e07a65", "/files/:id"],
    ["https://a.com/orders/", "/orders"],
    ["https://a.com/", "/"],
    ["https://a.com/orders?page=2&sort=asc", "/orders"],
    ["https://a.com/orders#top", "/orders"],
    ["https://a.com/about-us", "/about-us"],
    ["https://a.com/v2/status", "/v2/status"],
  ])("%s -> %s", (url, want) => {
    expect(routePattern(url)).toBe(want);
  });

  it("is case-stable for the path of hex-like words", () => {
    expect(routePattern("https://a.com/settings/profile")).toBe("/settings/profile");
  });
});
