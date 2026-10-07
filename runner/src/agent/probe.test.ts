import { describe, expect, it } from "vitest";
import { probePage, type ProbeSession } from "./probe.js";
import type { ActionResult, ActionSpec, Inventory, Understanding } from "./interaction.js";

const empty: ActionResult = { requests: [], navigatedTo: null, status: 200, modal: null, messages: [], dialog: null };
const field = (ref: string, name: string, type = "text", extra: Partial<Inventory["forms"][number]["fields"][number]> = {}) => ({
  ref, name, type, label: name, required: false, placeholder: "", options: [], ...extra,
});

const clientsPage: Inventory = {
  title: "Clientes",
  headings: ["Clientes"],
  buttons: [
    { ref: "b0", label: "Novo cliente", kind: "button", disabled: false },
    { ref: "b1", label: "Sair", kind: "button", disabled: false },
    { ref: "b2", label: "Mostrar mais", kind: "toggle", disabled: false },
  ],
  forms: [
    { ref: "f0", method: "GET", action: "/clients", label: "Busca", fields: [field("i0", "q", "search")], submitRef: "b3", submitLabel: "Buscar", hasFile: false, hasPassword: false },
    {
      ref: "f1", method: "POST", action: "/clients", label: "Novo cliente",
      fields: [field("i1", "client[name]", "text", { required: true }), field("i2", "client[email]", "email")],
      submitRef: "b4", submitLabel: "Salvar", hasFile: false, hasPassword: false,
    },
    { ref: "f2", method: "POST", action: "/clients/1", label: "Remover", fields: [], submitRef: "b5", submitLabel: "Remover", hasFile: false, hasPassword: false },
    { ref: "f3", method: "POST", action: "/users/password", label: "Senha", fields: [field("i3", "password", "password")], submitRef: "b6", submitLabel: "Trocar senha", hasFile: false, hasPassword: true },
  ],
};

class FakeSession implements ProbeSession {
  visits = 0;
  performed: ActionSpec[] = [];
  constructor(
    private readonly inv: Inventory,
    private readonly reply: (a: ActionSpec) => Partial<ActionResult> = () => ({}),
  ) {}
  async visit() {
    this.visits++;
  }
  async inventory() {
    return structuredClone(this.inv);
  }
  async perform(a: ActionSpec): Promise<ActionResult> {
    this.performed.push(a);
    return { ...empty, ...this.reply(a) };
  }
}

const base = { pageUrl: "https://app.test/clients", policy: "block" as const, maxActions: 50, seed: (() => { let n = 0; return () => ++n; })(), shouldStop: () => false, deadline: Date.now() + 60_000 };
const labels = (s: FakeSession) => s.performed.map((a) => (a.type === "click" ? `click:${a.ref}` : `submit:${a.formRef}`));

describe("probePage: what it does on a page", () => {
  it("opens safe controls, searches and fills forms, and never touches logout, passwords or risky buttons", async () => {
    const s = new FakeSession(clientsPage);
    const res = await probePage({ ...base, session: s, inventory: clientsPage });
    expect(labels(s)).toEqual([
      "click:b0", // Novo cliente (opens something)
      "click:b2", // Mostrar mais
      "submit:f0", // the search
      "submit:f1", // the create form, empty first (validation) ...
      "submit:f1", // ... then with data
      "submit:f2", // risky form: only because the network guard aborts its request when the policy is block
    ]);
    expect(s.performed.some((a) => a.type === "click" && a.ref === "b1")).toBe(false); // Sair
    expect(s.performed.some((a) => a.type === "submit" && a.formRef === "f3")).toBe(false); // password form
    expect(res.skipped).toEqual({ never: 1, sensitive: 1, risky: 0 });
  });

  it("fills with plausible data: the search gets a term, the create form valid values, the first try empty", async () => {
    const s = new FakeSession(clientsPage);
    await probePage({ ...base, session: s, inventory: clientsPage });
    const submits = s.performed.filter((a): a is Extract<ActionSpec, { type: "submit" }> => a.type === "submit");
    expect(submits[0]?.values).toEqual({ i0: "teste" });
    expect(submits[1]?.values).toEqual({}); // empty try
    expect(submits[2]?.values).toEqual({ i1: expect.stringMatching(/^Cliente QA \d+$/), i2: expect.stringMatching(/^qa\.\d+@exemplo\.invalid$/) });
  });

  it("uses the values the analyst proposed and leaves the rest to the generator", async () => {
    const understanding: Understanding = {
      summary: "Lista de clientes",
      buttons: { b0: { intent: "create", description: "abre o cadastro" } },
      forms: { f1: { purpose: "cadastrar cliente", values: { i1: "Maria Silva" } } },
    };
    const s = new FakeSession(clientsPage);
    await probePage({ ...base, session: s, inventory: clientsPage, understanding });
    const valid = s.performed.filter((a): a is Extract<ActionSpec, { type: "submit" }> => a.type === "submit" && a.formRef === "f1")[1];
    expect(valid?.values["i1"]).toBe("Maria Silva");
    expect(valid?.values["i2"]).toMatch(/@exemplo\.invalid$/);
  });

  it("starts every action from a clean page, so one action never leaks into the next", async () => {
    const s = new FakeSession(clientsPage);
    await probePage({ ...base, session: s, inventory: clientsPage });
    expect(s.visits).toBe(s.performed.length - 1); // the page was already loaded for the first one
  });

  it("does the risky ones last and, in an environment that allows it, really accepts the confirmation", async () => {
    const s = new FakeSession(clientsPage);
    await probePage({ ...base, session: s, inventory: clientsPage, policy: "allow" });
    const last = s.performed[s.performed.length - 1];
    expect(last).toMatchObject({ type: "submit", formRef: "f2", accept: true });
  });

  it("skips risky buttons (not forms) when the environment does not allow them", async () => {
    const inv: Inventory = { ...clientsPage, forms: [], buttons: [{ ref: "b0", label: "Excluir tudo", kind: "button", disabled: false }, { ref: "b1", label: "Reenviar", kind: "button", disabled: false }] };
    const s = new FakeSession(inv);
    const res = await probePage({ ...base, session: s, inventory: inv });
    expect(s.performed).toEqual([]);
    expect(res.skipped.risky).toBe(2);
    const allowed = new FakeSession(inv);
    await probePage({ ...base, session: allowed, inventory: inv, policy: "allow" });
    expect(allowed.performed).toHaveLength(2);
  });

  it("respects the action budget, cancellation and the deadline", async () => {
    const s = new FakeSession(clientsPage);
    await probePage({ ...base, session: s, inventory: clientsPage, maxActions: 2 });
    expect(s.performed).toHaveLength(2);

    const stopped = new FakeSession(clientsPage);
    await probePage({ ...base, session: stopped, inventory: clientsPage, shouldStop: () => true });
    expect(stopped.performed).toEqual([]);

    const late = new FakeSession(clientsPage);
    await probePage({ ...base, session: late, inventory: clientsPage, deadline: Date.now() - 1 });
    expect(late.performed).toEqual([]);
  });

  it("records what each action produced, with the intent read from the button's name", async () => {
    const s = new FakeSession(clientsPage, (a) =>
      a.type === "submit" && a.formRef === "f1" && Object.keys(a.values).length > 0
        ? { requests: [{ method: "POST", path: "/clients", resource: "document", status: null, blocked: true, fields: ["client[name]"] }] }
        : {},
    );
    const { outcomes } = await probePage({ ...base, session: s, inventory: clientsPage });
    const created = outcomes.find((o) => o.kind === "submit-valid" && o.form?.action === "/clients");
    expect(created).toMatchObject({ intent: "save", label: "Salvar", form: { action: "/clients", method: "POST" } });
    expect(created?.result.requests[0]?.method).toBe("POST");
    expect(outcomes.find((o) => o.label === "Novo cliente" && o.kind === "click")?.intent).toBe("create");
    expect(outcomes.find((o) => o.label === "Buscar")?.kind).toBe("search");
  });
});

describe("probePage: modals", () => {
  const modalForm = { ref: "f9", method: "POST", action: "/clients", label: "Cadastro", fields: [field("i9", "name", "text", { required: true })], submitRef: "b9", submitLabel: "Criar", hasFile: false, hasPassword: false };
  const modalInv: Inventory = { title: "", headings: [], buttons: [], forms: [modalForm] };

  it("goes inside a modal that a click opened: reopens it and works on its form", async () => {
    const page: Inventory = { title: "Clientes", headings: [], forms: [], buttons: [{ ref: "b0", label: "Novo cliente", kind: "button", disabled: false }] };
    let open = false;
    const s = new (class extends FakeSession {
      override async visit() {
        open = false;
        await super.visit();
      }
      override async inventory() {
        return structuredClone(open ? { ...page, forms: [modalForm] } : page);
      }
      override async perform(a: ActionSpec) {
        if (a.type === "click") open = true;
        return super.perform(a);
      }
    })(page, (a) => (a.type === "click" ? { modal: { signature: "dialog(form)", inventory: modalInv } } : {}));

    const { outcomes } = await probePage({ ...base, session: s, inventory: page });
    expect(outcomes.map((o) => `${o.kind}:${o.label}${o.via ? `<${o.via}` : ""}`)).toEqual([
      "click:Novo cliente",
      "submit-empty:Criar<Novo cliente",
      "submit-valid:Criar<Novo cliente",
    ]);
    // each nested action reopened the modal first: visit, click the opener, then submit
    expect(s.performed.map((a) => a.type)).toEqual(["click", "click", "submit", "click", "submit"]);
  });
});
