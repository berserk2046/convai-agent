import { ODONTOLOGIA_SOURCE } from "@platform/db/testing";
import { databaseEnv, parseEnv } from "@platform/shared";
import { describe, expect, it } from "vitest";
import { runEvalSuite, type SuiteInput } from "./runner.ts";
import { fakeDentalLlm } from "./testing.ts";

/**
 * Appendix A's evals through the real pipeline (webhook ingest → agent → mock channel) in
 * a scratch database, with a rule-based fake in place of Claude (./testing.ts).
 */

const { DATABASE_URL: serverUrl } = parseEnv(databaseEnv);
const JUDGE = "claude-sonnet-5-5";

const suite = (input: Partial<SuiteInput>) =>
  runEvalSuite({
    serverUrl,
    sourceYaml: ODONTOLOGIA_SOURCE,
    mode: "live",
    runs: 1,
    judgeModel: JUDGE,
    concurrency: 3,
    ...input,
  });

const byId = (report: Awaited<ReturnType<typeof suite>>["report"], id: string) => {
  const scenario = report.scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`no ${id}`);
  return scenario;
};

describe("runEvalSuite", () => {
  it("runs scenarios end to end and checks every assertion", async () => {
    const { report } = await suite({
      live: fakeDentalLlm(),
      only: [
        "precio_limpieza",
        "agenda_simple",
        "urgencia",
        "opt_out",
        "consentimiento",
        "consejo_medicamento",
      ],
    });
    for (const scenario of report.scenarios) {
      expect({
        id: scenario.id,
        status: scenario.runs[0]?.status,
        assertions: scenario.runs[0]?.assertions,
      }).toMatchObject({ id: scenario.id, status: "passed" });
    }
    const booking = byId(report, "agenda_simple").runs[0];
    expect(booking?.assertions.map((a) => a.name)).toEqual([
      "expect_tool",
      "tool_called",
      "booking_created",
      "bookings_count",
    ]);
    expect(booking?.finalState?.bookings).toMatchObject([
      { serviceKey: "limpieza", localDate: "2026-10-08", localTime: "15:00", status: "pending" },
    ]);
    // The mock clock moves a minute per message, from the scenario's clock.
    expect(booking?.transcript.map((t) => t.at.slice(11, 16))).toEqual(["09:00", "09:01", "09:02"]);
    // The emergency reply is template text: no model call, no cost.
    const urgent = byId(report, "urgencia").runs[0];
    expect(urgent?.transcript[0]?.replies[0]?.kind).toBe("fixed");
    expect(urgent?.usage.input).toBe(0);
    expect(byId(report, "consejo_medicamento").runs[0]?.assertions.at(-1)).toMatchObject({
      name: "judge",
      passed: true,
    });
    // A partial suite never passes the gate.
    expect(report.summary).toMatchObject({ passRate: 1, criticalPass: true, gatePassed: false });
    expect(report.only).toHaveLength(6);
    expect(report.costUsd).toBeGreaterThan(0);
  });

  it("reports what it has spent after each scenario run", async () => {
    const spent: number[] = [];
    const { report } = await suite({
      live: fakeDentalLlm(),
      only: ["precio_limpieza", "inyeccion"],
      concurrency: 1,
      onProgress: (_done, _total, costUsd) => {
        spent.push(costUsd);
      },
    });
    expect(spent).toHaveLength(2);
    expect(spent[0]).toBeGreaterThan(0);
    expect(spent[1]).toBeCloseTo(report.costUsd, 10);
  });

  it("fails a scenario whose reply breaks an assertion, and repeats runs", async () => {
    const { report } = await suite({
      live: fakeDentalLlm({ quoteEndodoncia: true }),
      only: ["precio_tras_valoracion"],
      runs: 2,
    });
    const scenario = byId(report, "precio_tras_valoracion");
    expect(scenario.runs.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(scenario.runs[0]?.assertions.find((a) => !a.passed)).toMatchObject({
      name: "reply_not_matches",
    });
    expect(report.summary).toMatchObject({ passedRuns: 0, criticalPass: false });
  });

  it("stops at a failed expect_tool checkpoint", async () => {
    // A fake that never checks availability: it answers the first message with text.
    const llm = fakeDentalLlm();
    const lazy = {
      createMessage: (params: Parameters<typeof llm.createMessage>[0]) => {
        const last = params.messages.at(-1);
        if (typeof last?.content === "string" && last.content.includes("jueves")) {
          return llm.createMessage({ ...params, messages: [{ role: "user", content: "hola" }] });
        }
        return llm.createMessage(params);
      },
    };
    const { report } = await suite({ live: lazy, only: ["agenda_simple"] });
    const run = byId(report, "agenda_simple").runs[0];
    expect(run?.status).toBe("failed");
    expect(run?.assertions).toEqual([
      expect.objectContaining({ name: "expect_tool", passed: false }),
    ]);
    expect(run?.transcript).toHaveLength(1);
  });

  it("records a live run and replays it without calling the API", async () => {
    const only = ["precio_limpieza", "agenda_simple", "consejo_medicamento"];
    const live = fakeDentalLlm();
    const recorded = await suite({ live, only, record: true });
    expect(recorded.recording?.scenarios.agenda_simple?.calls.length).toBe(6);

    const replayed = await suite({ mode: "replay", recordings: recorded.recording, only });
    expect(replayed.report.scenarios.map((s) => s.runs[0]?.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    // Replays spend nothing; the booking in the new database got the same slot.
    expect(replayed.report.costUsd).toBe(0);
    expect(byId(replayed.report, "agenda_simple").runs[0]?.finalState?.bookings).toHaveLength(1);

    // A prompt change makes the recordings stale: replay errors instead of guessing.
    const changed = ODONTOLOGIA_SOURCE.replace("Nada más.", "Nada más que eso.");
    const stale = await suite({
      mode: "replay",
      recordings: recorded.recording,
      sourceYaml: changed,
      only: ["precio_limpieza"],
    });
    const run = byId(stale.report, "precio_limpieza").runs[0];
    expect(run?.status).toBe("error");
    expect(run?.error).toMatch(/Re-record/);
  });

  it("reports an API failure as an error, not as the agent's handoff", async () => {
    const failing = {
      createMessage: () => Promise.reject(new Error("invalid x-api-key")),
    };
    const { report } = await suite({ live: failing, only: ["precio_limpieza"] });
    const run = byId(report, "precio_limpieza").runs[0];
    expect(run?.status).toBe("error");
    expect(run?.error).toMatch(/invalid x-api-key/);
  });

  it("stops starting scenarios when aborted, then fails without leaving its database", async () => {
    const controller = new AbortController();
    const run = suite({
      live: fakeDentalLlm(),
      only: ["precio_limpieza", "urgencia", "opt_out", "consejo_medicamento"],
      concurrency: 1,
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
    });
    await expect(run).rejects.toThrow();
  });
});
