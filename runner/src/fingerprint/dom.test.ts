// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { domSignature } from "./dom.js";

function sig(html: string): string {
  document.body.innerHTML = html;
  return domSignature(document.body);
}

describe("domSignature", () => {
  it("ignores text and data", () => {
    expect(sig("<main><h1>Hello Ana</h1><p>Welcome back</p></main>")).toBe(sig("<main><h1>Bye Bob</h1><p>Other text</p></main>"));
  });

  it("collapses repeated siblings so list length does not matter", () => {
    const row = (n: number) => `<tr><td>${n}</td><td><a href="/o/${n}">x</a></td></tr>`;
    const table = (rows: number) => `<table><tbody>${Array.from({ length: rows }, (_, i) => row(i)).join("")}</tbody></table>`;
    expect(sig(table(2))).toBe(sig(table(25)));
  });

  it("distinguishes different structures", () => {
    expect(sig("<main><form><input type='text'><input type='password'><button>Go</button></form></main>")).not.toBe(
      sig("<main><ul><li>a</li></ul></main>"),
    );
  });

  it("distinguishes field types and ARIA roles", () => {
    expect(sig("<form><input type='text'></form>")).not.toBe(sig("<form><input type='email'></form>"));
    expect(sig("<div role='dialog'></div>")).not.toBe(sig("<div role='alert'></div>"));
  });

  it("ignores scripts, styles and attribute noise like classes and ids", () => {
    expect(sig("<main><script>1</script><style>a{}</style><p class='x' id='y'>t</p></main>")).toBe(sig("<main><p>t</p></main>"));
  });

  it("is deterministic", () => {
    const html = "<nav><a href='/a'>a</a></nav><main><form><input name='q'></form></main>";
    expect(sig(html)).toBe(sig(html));
  });
});
