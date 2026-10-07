import { describe, expect, it } from "vitest";
import { bugStatusLabel, cronLabel, plural, runDuration, runStatusLabel, runTypeLabel, severityLabel, stepResultLabel, timeAgo, triggerLabel } from "./format";

const NOW = Date.parse("2026-10-01T12:00:00Z");

describe("timeAgo", () => {
  it("speaks in the unit people use", () => {
    expect(timeAgo("2026-10-01T11:59:50Z", NOW)).toBe("agora há pouco");
    expect(timeAgo("2026-10-01T11:55:00Z", NOW)).toBe("há 5 min");
    expect(timeAgo("2026-10-01T09:00:00Z", NOW)).toBe("há 3 h");
    expect(timeAgo("2026-09-29T12:00:00Z", NOW)).toBe("há 2 dias");
    expect(timeAgo("2026-09-30T11:00:00Z", NOW)).toBe("ontem");
    expect(timeAgo(null, NOW)).toBe("—");
  });
});

describe("runDuration", () => {
  it("measures started to finished, or started to now while it runs", () => {
    expect(runDuration({ started_at: "2026-10-01T11:00:00Z", finished_at: "2026-10-01T11:01:30Z" }, NOW)).toBe("1 min 30 s");
    expect(runDuration({ started_at: "2026-10-01T11:59:40Z", finished_at: null }, NOW)).toBe("20 s");
    expect(runDuration({ started_at: null, finished_at: null }, NOW)).toBe("—");
  });
});

describe("labels", () => {
  it("translates run vocabulary", () => {
    expect(runTypeLabel("exploration")).toBe("Exploração");
    expect(runTypeLabel("regression")).toBe("Regressão");
    expect(runStatusLabel("succeeded")).toBe("Concluído");
    expect(runStatusLabel("queued")).toBe("Na fila");
    expect(triggerLabel("schedule")).toBe("Agendado");
    expect(triggerLabel("ci")).toBe("CI");
    expect(triggerLabel("manual")).toBe("Manual");
  });

  it("translates bug and result vocabulary, and unknown words pass through", () => {
    expect(severityLabel("critical")).toBe("crítico");
    expect(bugStatusLabel("false_positive")).toBe("falso positivo");
    expect(stepResultLabel("fail")).toBe("falhou");
    expect(stepResultLabel("whatever")).toBe("whatever");
  });

  it("agrees the noun with the number", () => {
    expect(plural(1, "novo", "novos")).toBe("1 novo");
    expect(plural(0, "novo", "novos")).toBe("0 novos");
    expect(plural(3, "novo", "novos")).toBe("3 novos");
  });

  it("describes the cron expressions people actually use, and shows the rest as is", () => {
    expect(cronLabel("0 2 * * *")).toBe("Todo dia às 02:00");
    expect(cronLabel("30 22 * * 1-5")).toBe("Dias úteis às 22:30");
    expect(cronLabel("0 */6 * * *")).toBe("A cada 6 horas");
    expect(cronLabel("*/15 * * * *")).toBe("A cada 15 minutos");
    expect(cronLabel("5 4 1 * *")).toBe("5 4 1 * *");
  });
});
