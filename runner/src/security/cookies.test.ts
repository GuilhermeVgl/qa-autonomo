import { describe, expect, it } from "vitest";
import { CookieJar, parseSetCookie } from "./cookies.js";

describe("parseSetCookie", () => {
  it("reads the flags the application set", () => {
    expect(parseSetCookie("_app_session=abc; path=/; HttpOnly; Secure; SameSite=Lax")?.flag).toEqual({ name: "_app_session", httpOnly: true, secure: true, sameSite: "lax" });
    expect(parseSetCookie("sid=1; Path=/; SameSite=None; Secure")?.flag).toMatchObject({ httpOnly: false, secure: true, sameSite: "none" });
    expect(parseSetCookie("theme=dark")?.flag).toEqual({ name: "theme", httpOnly: false, secure: false, sameSite: "unset" });
    expect(parseSetCookie("a=b; samesite=STRICT")?.flag.sameSite).toBe("strict");
  });

  it("knows when the line deletes the cookie", () => {
    expect(parseSetCookie("sid=; Max-Age=0")?.deleted).toBe(true);
    expect(parseSetCookie("sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT")?.deleted).toBe(true);
    expect(parseSetCookie("sid=x; Max-Age=3600")?.deleted).toBe(false);
  });

  it("is nothing for a line that is not a cookie", () => {
    expect(parseSetCookie("")).toBeNull();
    expect(parseSetCookie("novalue")).toBeNull();
    expect(parseSetCookie("=x")).toBeNull();
  });
});

describe("CookieJar", () => {
  it("keeps the last word on each cookie and forgets the ones deleted", () => {
    const jar = new CookieJar();
    jar.record("a=1; HttpOnly\nb=2; Secure");
    jar.record("a=3; Secure; SameSite=Lax");
    jar.record("b=; Max-Age=0");
    expect(jar.flags()).toEqual([{ name: "a", httpOnly: false, secure: true, sameSite: "lax" }]);
  });
});
