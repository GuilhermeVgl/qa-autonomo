import type { CookieFlag } from "./types.js";

/** One `Set-Cookie` line as the application sent it: the name and the flags it set. A line that deletes the cookie is `null`. */
export function parseSetCookie(line: string): { flag: CookieFlag; deleted: boolean } | null {
  const [pair, ...attrs] = line.split(";").map((s) => s.trim());
  const eq = (pair ?? "").indexOf("=");
  if (!pair || eq <= 0) return null;
  const name = pair.slice(0, eq);
  let httpOnly = false;
  let secure = false;
  let sameSite: CookieFlag["sameSite"] = "unset";
  let deleted = pair.slice(eq + 1) === "";
  for (const a of attrs) {
    const [k, v = ""] = a.split("=").map((s) => s.trim());
    switch ((k ?? "").toLowerCase()) {
      case "httponly":
        httpOnly = true;
        break;
      case "secure":
        secure = true;
        break;
      case "samesite":
        sameSite = v.toLowerCase() === "strict" ? "strict" : v.toLowerCase() === "lax" ? "lax" : v.toLowerCase() === "none" ? "none" : "unset";
        break;
      case "max-age":
        if (Number(v) <= 0) deleted = true;
        break;
      case "expires":
        if (Date.parse(v) < Date.now()) deleted = true;
        break;
    }
  }
  return { flag: { name, httpOnly, secure, sameSite }, deleted };
}

/** The cookies an application has set during a session: the last word of each name stands, and deleting one removes it. */
export class CookieJar {
  private readonly cookies = new Map<string, CookieFlag>();

  /** Takes the value of the `Set-Cookie` header(s) of a response: Playwright joins several lines with a line break. */
  record(header: string): void {
    for (const line of header.split("\n")) {
      const parsed = parseSetCookie(line);
      if (!parsed) continue;
      if (parsed.deleted) this.cookies.delete(parsed.flag.name);
      else this.cookies.set(parsed.flag.name, parsed.flag);
    }
  }

  flags(): CookieFlag[] {
    return [...this.cookies.values()];
  }
}
