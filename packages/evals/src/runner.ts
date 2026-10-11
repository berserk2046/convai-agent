import type { ToolCallLog } from "@platform/core";
import {
  createDb,
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
  sourceSha256,
  type Database,
  type EvalMode,
  type TemplateRow,
} from "@platform/db";
import { NO_USAGE, addUsage, type LlmClient } from "@platform/llm";
import {
  getPath,
  validateTemplateSource,
  type EvalScenario,
  type Template,
} from "@platform/templates";
import { DateTime } from "luxon";
import {
  checkAssertions,
  expectTool,
  type AssertionResult,
  type ObservedTurn,
} from "./assertions.ts";
import { judge } from "./judge.ts";
import { captureLogs } from "./logs.ts";
import { meterCalls } from "./meter.ts";
import {
  ReplayMissError,
  recordingLlm,
  replayLlm,
  type RecordedCall,
  type RecordingFile,
} from "./replay.ts";
import {
  DEFAULT_EVAL_CLOCK,
  gateSummary,
  type EvalReport,
  type RunReport,
  type ScenarioReport,
  type TranscriptTurn,
} from "./report.ts";
import {
  createSandbox,
  customerSays,
  installTemplate,
  sandboxState,
  type SandboxState,
} from "./sandbox.ts";

/**
 * The eval runner (spec §11): every scenario of a template, `runs` times, each in its own
 * sandbox business inside one scratch database, with a mock clock and a mock channel.
 */

/** Each user message comes this long after the previous one on the mock clock. */
const TURN_GAP_MS = 60_000;

export interface ScenarioRunInput {
  db: Database;
  template: TemplateRow;
  scenario: EvalScenario;
  /** 1-based. */
  run: number;
  /** Agent and judge calls (live, recording or replay). */
  llm: LlmClient;
  billable: boolean;
  judgeModel: string;
}

export async function runScenario(input: ScenarioRunInput): Promise<RunReport> {
  const started = Date.now();
  const { scenario, template } = input;
  const manifest = template.manifest;
  const { logger, entries: logs } = captureLogs();
  const llm = meterCalls(input.llm, { billable: input.billable });
  const start = DateTime.fromISO(scenario.clock ?? DEFAULT_EVAL_CLOCK, { setZone: true });
  let elapsed = 0;
  const now = () => new Date(start.toMillis() + elapsed);

  const sandbox = await createSandbox(input.db, template, {
    name: `Eval ${scenario.id} #${String(input.run)}`,
    config: manifest.sample_config,
    resources: (manifest.eval_fixtures?.resources ?? []).map((r) => ({
      kind: r.kind,
      name: r.name,
      capacity: r.capacity ?? null,
    })),
    contact: {
      name: scenario.fixtures?.contact?.name ?? null,
      fields: scenario.fixtures?.contact?.fields ?? {},
      // Spec §11: the eval contact has consented, unless the scenario tests consent.
      consentAt: scenario.consent === "pending" ? null : new Date(start.toMillis() - 86_400_000),
    },
    bookings: (scenario.fixtures?.bookings ?? []).map((b) => ({
      serviceKey: b.service_key,
      startsAt: new Date(b.starts_at),
      subjectName: b.subject_name,
      ...(b.status ? { status: b.status } : {}),
    })),
  });
  const deps = { db: input.db, logger, llm, now, billable: input.billable };

  const turns: ObservedTurn[] = [];
  const transcript: TranscriptTurn[] = [];
  const checkpoints: AssertionResult[] = [];
  let error: string | null = null;

  for (const step of scenario.turns) {
    if (step.expect_tool !== undefined) {
      const result = expectTool(step.expect_tool, turns.at(-1));
      checkpoints.push(result);
      if (!result.passed) break;
      continue;
    }
    const at = now();
    const outcome = await customerSays(deps, sandbox, step.user ?? "");
    const failure = outcome.error ?? outcome.llmErrors[0];
    turns.push({ user: step.user ?? "", replies: outcome.replies, toolCalls: outcome.toolCalls });
    transcript.push({
      at: DateTime.fromJSDate(at, { zone: sandbox.timezone }).toISO() ?? "",
      user: step.user ?? "",
      replies: outcome.replies,
      toolCalls: outcome.toolCalls.map(toolView),
      costUsd: outcome.costUsd,
    });
    if (failure !== undefined && failure !== null) {
      error = errorText(failure);
      break;
    }
    elapsed += TURN_GAP_MS;
  }

  let finalState: SandboxState | null = null;
  const assertions = [...checkpoints];
  if (error === null) {
    finalState = await sandboxState(input.db, sandbox);
    if (checkpoints.every((c) => c.passed)) {
      const catalog = getPath(manifest.sample_config, manifest.guardrails.price_guard.catalog_path);
      assertions.push(
        ...checkAssertions(scenario.assert, {
          turns,
          state: finalState,
          catalog: Array.isArray(catalog) ? (catalog as Record<string, unknown>[]) : [],
          priceField: manifest.guardrails.price_guard.price_field,
        }),
      );
      if (scenario.assert.judge !== undefined) {
        try {
          assertions.push(
            await judge(llm, input.judgeModel, scenario.assert.judge, turns, finalState),
          );
        } catch (caught) {
          error = `the judge failed: ${errorText(caught)}`;
        }
      }
    }
  }

  return {
    run: input.run,
    status: error !== null ? "error" : assertions.every((a) => a.passed) ? "passed" : "failed",
    error,
    assertions,
    transcript,
    finalState,
    usage: llm.usage(),
    costUsd: llm.costUsd(),
    durationMs: Date.now() - started,
    logs,
  };
}

// --- a whole template --------------------------------------------------------------------

export interface SuiteInput {
  /** Postgres server for the scratch database (any database URL on it). */
  serverUrl: string;
  sourceYaml: string;
  mode: EvalMode;
  runs: number;
  only?: readonly string[];
  concurrency?: number;
  /** Live mode: the Anthropic client. */
  live?: LlmClient;
  /** Live mode: keep every response, to write a recording file. */
  record?: boolean;
  /** Replay mode: the template's recordings. */
  recordings?: RecordingFile | null;
  judgeModel: string;
  /** Stops starting new scenario runs; the suite then throws. */
  signal?: AbortSignal;
  /** After each scenario run: runs done, runs in total, and USD spent so far. */
  onProgress?: (done: number, total: number, costUsd: number) => Promise<void> | void;
}

export interface SuiteResult {
  report: EvalReport;
  /** Live runs with `record`: one passing run per scenario where there is one. */
  recording: RecordingFile | null;
}

export async function runEvalSuite(input: SuiteInput): Promise<SuiteResult> {
  const startedAt = new Date();
  const parsed = validateTemplateSource(input.sourceYaml);
  if (!parsed.ok || !parsed.template) throw new Error("the template does not validate");
  const template: Template = parsed.template;
  const scenarios = selectScenarios(template, input.only);
  if (input.mode === "live" && !input.live) throw new Error("live mode needs an Anthropic client");

  const name = scratchDatabaseName("eval", startedAt);
  const url = await createScratchDatabase(input.serverUrl, name);
  const concurrency = Math.max(1, input.concurrency ?? 4);
  const handle = createDb(url, { maxConnections: concurrency * 2 + 2 });
  try {
    const row = await installTemplate(handle.db, {
      slug: template.manifest.slug,
      version: template.manifest.version,
      sourceYaml: input.sourceYaml,
    });
    const tasks = scenarios.flatMap((scenario) =>
      Array.from({ length: input.runs }, (_, i) => ({ scenario, run: i + 1 })),
    );
    let done = 0;
    let spent = 0;
    const results = await pool(tasks, concurrency, input.signal, async ({ scenario, run }) => {
      const calls: RecordedCall[] = [];
      const llm = scenarioLlm(input, scenario.id, calls);
      const report = await runScenario({
        db: handle.db,
        template: row,
        scenario,
        run,
        llm,
        billable: input.mode === "live",
        judgeModel: input.judgeModel,
      });
      done += 1;
      spent += report.costUsd;
      await input.onProgress?.(done, tasks.length, spent);
      return { id: scenario.id, report, calls };
    });

    const scenarioReports: ScenarioReport[] = scenarios.map((scenario) => {
      const runs = results.filter((r) => r.id === scenario.id).map((r) => r.report);
      return {
        id: scenario.id,
        critical: scenario.critical,
        passedRuns: runs.filter((r) => r.status === "passed").length,
        runs,
      };
    });
    const complete = input.only === undefined || input.only.length === 0;
    const report: EvalReport = {
      format: 1,
      template: {
        slug: template.manifest.slug,
        version: template.manifest.version,
        sourceSha256: sourceSha256(input.sourceYaml),
      },
      mode: input.mode,
      runsPerScenario: input.runs,
      only: complete ? null : scenarios.map((s) => s.id),
      agentModel: template.agent.model,
      judgeModel: input.judgeModel,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      summary: gateSummary(scenarioReports, complete),
      usage: results.reduce((u, r) => addUsage(u, r.report.usage), NO_USAGE),
      costUsd: results.reduce((c, r) => c + r.report.costUsd, 0),
      scenarios: scenarioReports,
    };
    return { report, recording: input.record ? recordingOf(template, results) : null };
  } finally {
    await handle.close();
    await dropScratchDatabase(input.serverUrl, name);
  }
}

function selectScenarios(template: Template, only: readonly string[] | undefined): EvalScenario[] {
  if (!only || only.length === 0) return template.evals;
  const unknown = only.filter((id) => !template.evals.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`unknown eval id(s): ${unknown.join(", ")}`);
  return template.evals.filter((s) => only.includes(s.id));
}

function scenarioLlm(input: SuiteInput, scenario: string, sink: RecordedCall[]): LlmClient {
  if (input.mode === "replay") return replayLlm(input.recordings?.scenarios[scenario], scenario);
  const live = input.live;
  if (!live) throw new Error("live mode needs an Anthropic client");
  return input.record ? recordingLlm(live, sink) : live;
}

/** Per scenario, the calls of its first passing run (or its first run if none passed). */
function recordingOf(
  template: Template,
  results: readonly { id: string; report: RunReport; calls: RecordedCall[] }[],
): RecordingFile {
  const scenarios: RecordingFile["scenarios"] = {};
  for (const scenario of template.evals) {
    const runs = results.filter((r) => r.id === scenario.id);
    const chosen = runs.find((r) => r.report.status === "passed") ?? runs[0];
    if (chosen) scenarios[scenario.id] = { calls: chosen.calls };
  }
  return {
    format: 1,
    template: `${template.manifest.slug}@${template.manifest.version}`,
    recordedAt: new Date().toISOString(),
    scenarios,
  };
}

/**
 * Runs `work` over `items`, at most `limit` at a time, in input order. On an abort or a
 * failure no new item starts, and it waits for the ones in flight before throwing: the
 * caller drops the database they use right after.
 */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  async function lane(): Promise<void> {
    while (next < items.length && !failed && signal?.aborted !== true) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  const lanes = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, () => lane()),
  );
  const rejected = lanes.find((l): l is PromiseRejectedResult => l.status === "rejected");
  if (rejected) throw rejected.reason;
  signal?.throwIfAborted();
  return results;
}

function toolView(call: ToolCallLog): TranscriptTurn["toolCalls"][number] {
  return { name: call.name, input: call.input, result: call.result, isError: call.isError };
}

function errorText(error: unknown): string {
  if (error instanceof ReplayMissError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
