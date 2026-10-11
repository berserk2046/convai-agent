import { describe, expect, it } from "vitest";
import { gateSummary, publishBlocker, type RunReport, type ScenarioReport } from "./report.ts";

function scenario(id: string, critical: boolean, statuses: RunReport["status"][]): ScenarioReport {
  const runs = statuses.map((status, i): RunReport => ({
    run: i + 1,
    status,
    error: null,
    assertions: [],
    transcript: [],
    finalState: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    durationMs: 0,
    logs: [],
  }));
  return { id, critical, runs, passedRuns: statuses.filter((s) => s === "passed").length };
}

const ok = (id: string, critical = true) => scenario(id, critical, ["passed", "passed", "passed"]);

describe("the publish gate (spec §10)", () => {
  it("passes when every critical run passes and at least 90% of runs pass", () => {
    const scenarios = [
      ...Array.from({ length: 12 }, (_, i) => ok(`c${String(i)}`)),
      scenario("n1", false, ["passed", "failed", "passed"]),
      scenario("n2", false, ["passed", "passed", "failed"]),
      ok("n3", false),
    ];
    const summary = gateSummary(scenarios, true);
    expect(summary).toMatchObject({
      totalRuns: 45,
      passedRuns: 43,
      criticalPass: true,
      gatePassed: true,
    });
  });

  it("fails when one critical run fails, even at a high pass rate", () => {
    const scenarios = [
      ...Array.from({ length: 14 }, (_, i) => ok(`c${String(i)}`)),
      scenario("urgencia", true, ["passed", "error", "passed"]),
    ];
    const summary = gateSummary(scenarios, true);
    expect(summary.passRate).toBeGreaterThan(0.97);
    expect(summary).toMatchObject({
      criticalPass: false,
      gatePassed: false,
      failingCritical: ["urgencia"],
    });
  });

  it("fails below 90% overall", () => {
    const scenarios = [ok("c1"), scenario("n1", false, ["failed", "failed", "passed"])];
    expect(gateSummary(scenarios, true)).toMatchObject({ criticalPass: true, gatePassed: false });
  });

  it("never passes for a partial run (--only)", () => {
    expect(gateSummary([ok("c1")], false).gatePassed).toBe(false);
  });

  it("only a finished live run with 3 runs per scenario unlocks publishing", () => {
    const passing = {
      status: "finished",
      mode: "live" as const,
      runsPerScenario: 3,
      gatePassed: true,
      passRate: 1,
      criticalPass: true,
    };
    expect(publishBlocker(passing)).toBeNull();
    expect(publishBlocker(null)).toMatch(/Run the evals first/);
    expect(publishBlocker({ ...passing, status: "running" })).toMatch(/hasn't finished/);
    expect(publishBlocker({ ...passing, mode: "replay" })).toMatch(/live eval run/);
    expect(publishBlocker({ ...passing, runsPerScenario: 1 })).toMatch(/3 runs per scenario/);
    expect(publishBlocker({ ...passing, gatePassed: false, criticalPass: false })).toMatch(
      /critical eval failed/,
    );
    expect(publishBlocker({ ...passing, gatePassed: false, passRate: 0.8 })).toMatch(/passed 80%/);
  });
});
