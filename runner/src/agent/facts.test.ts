import { describe, expect, it } from "vitest";
import { factsFrom, pageActions } from "./facts.js";
import type { ActionResult, Outcome } from "./interaction.js";

const result = (over: Partial<ActionResult> = {}): ActionResult => ({ requests: [], navigatedTo: null, status: 200, modal: null, messages: [], dialog: null, ...over });
const outcome = (over: Partial<Outcome> & { result?: ActionResult }): Outcome => ({
  action: { type: "click", ref: "b0", label: "x" },
  kind: "click",
  intent: "other",
  label: "x",
  result: result(),
  ...over,
});

describe("factsFrom", () => {
  it("makes one endpoint per verb and path, so the same address with another verb is another endpoint", () => {
    const f = factsFrom([
      outcome({ label: "Salvar", intent: "save", kind: "submit-valid", result: result({ requests: [{ method: "POST", path: "/clients", resource: "document", status: 302, blocked: false, fields: ["client[name]"] }] }) }),
      outcome({ label: "Atualizar", intent: "edit", kind: "submit-valid", result: result({ requests: [{ method: "PATCH", path: "/clients/42", resource: "document", status: 302, blocked: false, fields: ["client[name]", "client[email]"] }] }) }),
      outcome({ label: "Remover", intent: "delete", kind: "submit-valid", result: result({ requests: [{ method: "DELETE", path: "/clients/42", resource: "document", status: null, blocked: true, fields: [] }] }) }),
      outcome({ label: "Ver", result: result({ requests: [{ method: "GET", path: "/clients/42", resource: "fetch", status: 200, blocked: false, fields: [] }] }) }),
    ]);
    expect(f.endpoints.map((e) => e.fingerprint).sort()).toEqual(["DELETE /clients/{id}", "GET /clients/{id}", "PATCH /clients/{id}", "POST /clients"]);
    const del = f.endpoints.find((e) => e.fingerprint === "DELETE /clients/{id}");
    expect(del).toMatchObject({ blocked: true, statuses: [], triggers: [{ label: "Remover", intent: "delete" }] });
    expect(f.endpoints.find((e) => e.fingerprint === "PATCH /clients/{id}")?.fields).toEqual(["client[name]", "client[email]"]);
  });

  it("merges repeated calls, keeping every status, field and trigger once", () => {
    const call = (status: number, fields: string[]) => ({ method: "POST", path: "/clients", resource: "document" as const, status, blocked: false, fields });
    const f = factsFrom([
      outcome({ label: "Salvar", kind: "submit-empty", result: result({ requests: [call(422, ["client[name]"])] }) }),
      outcome({ label: "Salvar", kind: "submit-valid", result: result({ requests: [call(302, ["client[name]", "client[email]"])] }) }),
    ]);
    expect(f.endpoints).toHaveLength(1);
    expect(f.endpoints[0]).toMatchObject({ statuses: [302, 422], fields: ["client[name]", "client[email]"], triggers: [{ label: "Salvar" }] });
  });

  it("leaves out plain page loads (they are links) and asset noise, but keeps data calls made with GET by scripts", () => {
    const f = factsFrom([
      outcome({
        result: result({
          requests: [
            { method: "GET", path: "/clients/new", resource: "document", status: 200, blocked: false, fields: [] },
            { method: "GET", path: "/api/clients", resource: "xhr", status: 200, blocked: false, fields: [] },
            { method: "OPTIONS", path: "/api/clients", resource: "fetch", status: 204, blocked: false, fields: [] },
          ],
        }),
      }),
    ]);
    expect(f.endpoints.map((e) => e.fingerprint)).toEqual(["GET /api/clients"]);
  });

  it("collects modals, where actions led, and what the page said and asked", () => {
    const modal = { signature: "dialog(form)", inventory: { title: "", headings: [], buttons: [], forms: [] } };
    const f = factsFrom([
      outcome({ label: "Novo cliente", intent: "create", result: result({ modal }) }),
      outcome({ label: "Salvar", kind: "submit-valid", intent: "save", result: result({ navigatedTo: "https://app.test/clients/7", messages: ["Cliente criado"] }) }),
      outcome({ label: "Remover", kind: "submit-valid", intent: "delete", result: result({ dialog: "Remover este cliente?", messages: ["Cliente criado"] }) }),
    ]);
    expect(f.modals).toEqual([{ label: "Novo cliente", signature: "dialog(form)", inventory: modal.inventory }]);
    expect(f.navigations).toEqual([{ url: "https://app.test/clients/7", label: "Salvar", intent: "save", kind: "submit-valid" }]);
    expect(f.messages).toEqual(["Cliente criado"]);
    expect(f.dialogs).toEqual(["Remover este cliente?"]);
  });
});

describe("pageActions", () => {
  it("summarises what was tried, for the node details", () => {
    const list = pageActions([
      outcome({ label: "Salvar", kind: "submit-valid", intent: "save", form: { action: "/clients", method: "POST" }, result: result({ requests: [{ method: "POST", path: "/clients", resource: "document", status: 302, blocked: false, fields: [] }], navigatedTo: "https://app.test/clients/7" }) }),
      outcome({ label: "Remover", kind: "submit-valid", intent: "delete", result: result({ requests: [{ method: "DELETE", path: "/clients/1", resource: "document", status: null, blocked: true, fields: [] }] }) }),
    ]);
    expect(list[0]).toMatchObject({ label: "Salvar", kind: "submit-valid", intent: "save", requests: ["POST /clients → 302"], went_to: "/clients/7" });
    expect(list[1]).toMatchObject({ requests: ["DELETE /clients/{id} (bloqueada pela política)"] });
  });

  it("is bounded", () => {
    const many = Array.from({ length: 80 }, (_, i) => outcome({ label: `b${i}` }));
    expect(pageActions(many)).toHaveLength(25);
  });
});
