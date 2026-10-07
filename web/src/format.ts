export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

/** "há 5 min", "ontem"... for a timestamp. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "agora há pouco";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  const days = Math.floor(s / 86400);
  return days === 1 ? "ontem" : `há ${days} dias`;
}

export function runDuration(run: { started_at?: string | null; finished_at?: string | null }, now = Date.now()): string {
  const start = run.started_at ? Date.parse(run.started_at) : NaN;
  if (Number.isNaN(start)) return "—";
  const end = run.finished_at ? Date.parse(run.finished_at) : now;
  return formatDuration(Math.max(0, (end - start) / 1000));
}

export const runTypeLabel = (type: string) => (type === "exploration" ? "Exploração" : type === "regression" ? "Regressão" : type);

const STATUS: Record<string, string> = { queued: "Na fila", running: "Em andamento", succeeded: "Concluído", failed: "Falhou", cancelled: "Cancelado" };
export const runStatusLabel = (status: string) => STATUS[status] ?? status;

const TRIGGER: Record<string, string> = { manual: "Manual", schedule: "Agendado", ci: "CI" };
export const triggerLabel = (trigger: string | undefined) => (trigger ? (TRIGGER[trigger] ?? trigger) : "Manual");

const SEVERITY: Record<string, string> = { critical: "crítico", high: "alto", normal: "normal" };
export const severityLabel = (s: string) => SEVERITY[s] ?? s;

const BUG_STATUS: Record<string, string> = { new: "novo", confirmed: "confirmado", fixed: "corrigido", false_positive: "falso positivo", reopened: "reaberto" };
export const bugStatusLabel = (s: string) => BUG_STATUS[s] ?? s;

const STEP_RESULT: Record<string, string> = { pass: "passou", fail: "falhou", error: "erro", skipped: "pulado", running: "em andamento" };
export const stepResultLabel = (r: string) => STEP_RESULT[r] ?? r;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const two = (n: string) => n.padStart(2, "0");

/** A readable description for the schedules people create most; anything else is shown as typed. */
export function cronLabel(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const fixedTime = /^\d+$/.test(min) && /^\d+$/.test(hour);
  if (fixedTime && dom === "*" && mon === "*" && dow === "*") return `Todo dia às ${two(hour)}:${two(min)}`;
  if (fixedTime && dom === "*" && mon === "*" && dow === "1-5") return `Dias úteis às ${two(hour)}:${two(min)}`;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (min === "0" && everyHours && dom === "*" && mon === "*" && dow === "*") return `A cada ${everyHours[1]} horas`;
  const everyMinutes = /^\*\/(\d+)$/.exec(min);
  if (everyMinutes && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `A cada ${everyMinutes[1]} minutos`;
  return cron;
}
