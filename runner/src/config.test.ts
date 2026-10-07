import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("reads required variables and splits labels", () => {
    const cfg = loadConfig({
      CONTROL_PLANE_URL: "https://cp.example",
      RUNNER_TOKEN: "t",
      RUNNER_LABELS: "browser, api",
    });
    expect(cfg).toMatchObject({ controlPlaneUrl: "https://cp.example", runnerToken: "t", labels: ["browser", "api"] });
  });

  it("defaults labels to empty", () => {
    const cfg = loadConfig({ CONTROL_PLANE_URL: "https://cp.example", RUNNER_TOKEN: "t" });
    expect(cfg.labels).toEqual([]);
  });

  it("accepts a bootstrap token instead of a runner token, plus a name", () => {
    const cfg = loadConfig({ CONTROL_PLANE_URL: "https://cp.example", RUNNER_BOOTSTRAP_TOKEN: "boot", RUNNER_NAME: "r1" });
    expect(cfg.runnerToken).toBeUndefined();
    expect(cfg.bootstrapToken).toBe("boot");
    expect(cfg.name).toBe("r1");
  });

  it("requires one of RUNNER_TOKEN or RUNNER_BOOTSTRAP_TOKEN", () => {
    expect(() => loadConfig({ CONTROL_PLANE_URL: "https://cp.example" })).toThrow();
  });

  it("rejects missing or invalid values", () => {
    expect(() => loadConfig({ RUNNER_TOKEN: "t" })).toThrow();
    expect(() => loadConfig({ CONTROL_PLANE_URL: "not-a-url", RUNNER_TOKEN: "t" })).toThrow();
  });
});
