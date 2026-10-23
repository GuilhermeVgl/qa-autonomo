import { describe, expect, it } from "vitest";
import { classifyIntent, effectiveMethod, endpointPath, fakeValue, formEncodedFields, isOwnAccountForm, needsAllow } from "./controls.js";
import type { FieldInfo } from "./interaction.js";

const field = (over: Partial<FieldInfo>): FieldInfo => ({ ref: "x", name: "", type: "text", label: "", required: false, placeholder: "", options: [], ...over });

describe("classifyIntent", () => {
  it("reads what a control does from its name, in Portuguese and English", () => {
    expect(classifyIntent("Salvar")).toBe("save");
    expect(classifyIntent("Criar cliente")).toBe("create");
    expect(classifyIntent("Novo pedido")).toBe("create");
    expect(classifyIntent("+ Adicionar documento")).toBe("create");
    expect(classifyIntent("Buscar")).toBe("search");
    expect(classifyIntent("Filtrar")).toBe("filter");
    expect(classifyIntent("Editar")).toBe("edit");
    expect(classifyIntent("Remover")).toBe("delete");
    expect(classifyIntent("Excluir cliente")).toBe("delete");
    expect(classifyIntent("Delete")).toBe("delete");
    expect(classifyIntent("Reenviar")).toBe("external");
    expect(classifyIntent("Solicitar documentos")).toBe("external");
    expect(classifyIntent("Send message")).toBe("external");
    expect(classifyIntent("Mostrar mais")).toBe("toggle");
    expect(classifyIntent("Voltar")).toBe("navigate");
    expect(classifyIntent("Ver detalhes")).toBe("navigate");
    expect(classifyIntent("Algo esquisito")).toBe("other");
  });

  it("never touches what ends the session or kills the account", () => {
    for (const label of ["Sair", "Logout", "Sign out", "Cancelar minha conta", "Excluir minha conta", "Delete account", "Desativar conta"]) {
      expect(classifyIntent(label)).toBe("never");
    }
    expect(classifyIntent("Entrar", { href: "/users/sign_out" })).toBe("never");
    expect(classifyIntent("Menu", { href: "/logout" })).toBe("never");
  });

  it("does not mistake a word for a longer one", () => {
    expect(classifyIntent("Sairdo")).not.toBe("never");
    expect(classifyIntent("Salvador")).not.toBe("save");
  });
});

describe("needsAllow", () => {
  it("only deleting and external effects wait for the environment to allow it", () => {
    expect(needsAllow("delete")).toBe(true);
    expect(needsAllow("external")).toBe(true);
    expect(needsAllow("create")).toBe(false);
    expect(needsAllow("save")).toBe(false);
    expect(needsAllow("open")).toBe(false);
  });
});

describe("isOwnAccountForm", () => {
  const own = (over: Partial<Parameters<typeof isOwnAccountForm>[0]> = {}) =>
    isOwnAccountForm({ action: "/profile", label: "Meu perfil", submitLabel: "Salvar", fields: [], ...over });

  it("flags forms that look like profile/account updates of the logged-in user", () => {
    expect(own()).toBe(true);
    expect(own({ action: "/settings/account", label: "Configurações", submitLabel: "Atualizar", fields: [{ ...field({ name: "email", label: "E-mail" }), type: "email" }] })).toBe(true);
    expect(own({ action: "/users/edit", fields: [{ ...field({ name: "current_password", label: "Senha atual", type: "password" }) }] })).toBe(true);
  });

  it("keeps regular business forms testable", () => {
    expect(
      own({
        action: "/clients",
        label: "Novo cliente",
        submitLabel: "Salvar",
        fields: [{ ...field({ name: "client[email]", label: "E-mail do cliente", type: "email" }) }],
      }),
    ).toBe(false);
  });
});

describe("fakeValue", () => {
  it("makes data that fits the field, unique per run", () => {
    expect(fakeValue(field({ type: "email", name: "client[email]" }), 7)).toBe("qa.7@exemplo.invalid");
    expect(fakeValue(field({ type: "tel", name: "phone" }), 7)).toMatch(/^\(11\) 9\d{4}-\d{4}$/);
    expect(fakeValue(field({ name: "client[name]", label: "Nome" }), 7)).toBe("Cliente QA 7");
    expect(fakeValue(field({ type: "textarea", name: "notes", label: "Observações" }), 7)).toBe("Texto de teste QA 7");
    expect(fakeValue(field({ type: "number", name: "qty" }), 7)).toBe("10");
    expect(fakeValue(field({ type: "number", name: "qty", min: "50" }), 7)).toBe("50");
    expect(fakeValue(field({ type: "date" }), 7, new Date("2026-10-01T12:00:00Z"))).toBe("2026-10-01");
    expect(fakeValue(field({ type: "url" }), 7)).toBe("https://exemplo.invalid");
    expect(fakeValue(field({ name: "cpf", label: "CPF" }), 7)).toBe("529.982.247-25");
    expect(fakeValue(field({ name: "q", type: "search" }), 7)).toBe("teste");
  });

  it("picks real options for selects and checks boxes, and leaves alone what it must not fill", () => {
    expect(fakeValue(field({ type: "select", options: ["RG", "CPF"] }), 1)).toBe("RG");
    expect(fakeValue(field({ type: "select", options: [] }), 1)).toBeNull();
    expect(fakeValue(field({ type: "checkbox" }), 1)).toBe(true);
    expect(fakeValue(field({ type: "radio" }), 1)).toBe(true);
    expect(fakeValue(field({ type: "file" }), 1)).toBeNull();
    expect(fakeValue(field({ type: "password" }), 1)).toBeNull();
    expect(fakeValue(field({ type: "hidden" }), 1)).toBeNull();
  });

  it("respects maxlength", () => {
    expect(fakeValue(field({ name: "name", maxlength: 6 }), 7)).toBe("Client");
  });
});

describe("endpointPath", () => {
  it("turns ids into {id} so every id of a route is one endpoint", () => {
    expect(endpointPath("/clients/42/matters/7")).toBe("/clients/{id}/matters/{id}");
    expect(endpointPath("/api/orders/0198c1f0-0000-7000-8000-000000000001")).toBe("/api/orders/{id}");
    expect(endpointPath("/")).toBe("/");
    expect(endpointPath("/clients")).toBe("/clients");
  });
});

describe("effectiveMethod", () => {
  it("reports the verb a Rails form really means", () => {
    expect(effectiveMethod("POST", "authenticity_token=abc&_method=delete")).toBe("DELETE");
    expect(effectiveMethod("POST", "_method=patch&client%5Bname%5D=x")).toBe("PATCH");
    expect(effectiveMethod("POST", "name=x")).toBe("POST");
    expect(effectiveMethod("PUT", null)).toBe("PUT");
    expect(effectiveMethod("POST", "_method=get")).toBe("POST"); // only write verbs are honoured
  });
});

describe("formEncodedFields", () => {
  it("lists the names of the fields and never their values", () => {
    expect(formEncodedFields("authenticity_token=SECRET&client%5Bname%5D=Maria&_method=patch", "application/x-www-form-urlencoded")).toEqual(["client[name]"]);
    expect(formEncodedFields('{"name":"x","address":{"city":"y"}}', "application/json")).toEqual(["name", "address"]);
    expect(formEncodedFields(null, null)).toEqual([]);
    expect(formEncodedFields("not json", "application/json")).toEqual([]);
  });
});
