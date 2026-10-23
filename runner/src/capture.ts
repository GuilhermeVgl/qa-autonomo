/**
 * `npm run capture` — captures an authenticated browser session so the runner can test apps behind any login (SSO, 2FA,
 * captcha, magic link): a person logs in once in a visible browser, and the resulting storageState (cookies + storage) is
 * uploaded as a `session` credential. The agent then reuses the session and never performs the login itself.
 *
 * Usage:
 *   npm run capture -- --server https://cp.internal --token qat_... --env homolog --role admin --url https://app.internal
 *
 * The browser here has no host scope on purpose: the login may go through the identity provider's own domain.
 */
import { chromium } from "playwright";

interface Args {
  server: string;
  token: string;
  env: string;
  role: string;
  url: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string => {
    const i = argv.indexOf("--" + name);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v || v.startsWith("--")) throw new Error(`faltou --${name}`);
    return v;
  };
  return { server: get("server").replace(/\/+$/, ""), token: get("token"), env: get("env"), role: get("role"), url: get("url") };
}

async function waitForEnter(): Promise<void> {
  process.stdout.write("\nFaça login no navegador que abriu. Quando a aplicação estiver aberta e logada, volte aqui e tecle Enter.\n> ");
  await new Promise<void>((resolve) => {
    const onData = (): void => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write("uso: npm run capture -- --server <url> --token <qat_...> --env <nome> --role <papel> --url <url-da-app>\n");
    process.exit(2);
    return;
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(args.url).catch(() => undefined);
  await waitForEnter();

  const state = await context.storageState();
  await browser.close();

  const res = await fetch(`${args.server}/ci/v1/credentials/session`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.token}` },
    body: JSON.stringify({ environment: args.env, app_role: args.role, state: JSON.stringify(state) }),
  });
  if (!res.ok) {
    process.stderr.write(`falha ao salvar a sessão: HTTP ${res.status} ${await res.text().catch(() => "")}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`\nSessão salva para o papel "${args.role}" no ambiente "${args.env}". O agente agora entra com ela.\n`);
}

void main();
