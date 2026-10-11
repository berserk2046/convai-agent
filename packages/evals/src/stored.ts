import {
  claimQueuedEvalRun,
  failEvalRun,
  failStaleEvalRuns,
  finishEvalRun,
  getTemplateVersion,
  setTemplateEvalReport,
  sourceSha256,
  touchEvalRun,
  type Database,
  type EvalRunRow,
} from "@platform/db";
import type { LlmClient } from "@platform/llm";
import type { Logger } from "@platform/shared";
import { setTimeout as sleep } from "node:timers/promises";
import { runEvalSuite } from "./runner.ts";

/**
 * Eval runs stored in `eval_runs` (ADR 0015): the admin queues one, the worker's loop
 * claims and runs it; `pnpm template eval <slug>@<version>` runs one in place. Stored runs
 * are always live: replay recordings live in the repository, for CI.
 */

export interface StoredRunDeps {
  db: Database;
  /** The platform database URL; scratch databases go on the same server. */
  databaseUrl: string;
  logger: Logger;
  /** Null without ANTHROPIC_API_KEY: runs then fail with a clear message. */
  llm: LlmClient | null;
  judgeModel: string;
  now: () => Date;
  concurrency?: number;
  signal?: AbortSignal;
}

export async function executeEvalRun(
  deps: StoredRunDeps,
  run: EvalRunRow,
): Promise<EvalRunRow | null> {
  const log = deps.logger.child({
    eval_run_id: run.id,
    template: `${run.templateSlug}@${run.templateVersion}`,
  });
  const fail = async (message: string) => {
    log.warn({ reason: message }, "eval run failed");
    await failEvalRun(deps.db, run.id, message, deps.now());
    return null;
  };
  if (run.mode !== "live") return fail("Stored eval runs are live; replay runs from the CLI.");
  if (!deps.llm) return fail("ANTHROPIC_API_KEY is not set where the evals run (the worker).");
  const template = await getTemplateVersion(deps.db, run.templateSlug, run.templateVersion);
  if (!template) return fail("The template version no longer exists.");
  if (sourceSha256(template.sourceYaml) !== run.sourceSha256) {
    return fail("This draft was uploaded again after the run was requested; run the evals again.");
  }

  log.info({ runs: run.runsPerScenario }, "eval run started");
  try {
    const { report } = await runEvalSuite({
      serverUrl: deps.databaseUrl,
      sourceYaml: template.sourceYaml,
      mode: "live",
      runs: run.runsPerScenario,
      live: deps.llm,
      judgeModel: deps.judgeModel,
      ...(deps.concurrency ? { concurrency: deps.concurrency } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      onProgress: (done, total) => touchEvalRun(deps.db, run.id, { done, total }, deps.now()),
    });
    const { summary } = report;
    const finished = await finishEvalRun(deps.db, run.id, {
      results: report,
      passRate: summary.passRate,
      criticalPass: summary.criticalPass,
      gatePassed: summary.gatePassed,
      costUsd: report.costUsd,
      now: deps.now(),
    });
    await setTemplateEvalReport(deps.db, run.templateSlug, run.templateVersion, {
      run_id: run.id,
      mode: report.mode,
      finished_at: report.finishedAt,
      pass_rate: summary.passRate,
      critical_pass: summary.criticalPass,
      gate_passed: summary.gatePassed,
      source_sha256: run.sourceSha256,
    });
    log.info(
      { pass_rate: summary.passRate, gate_passed: summary.gatePassed, cost_usd: report.costUsd },
      "eval run finished",
    );
    return finished;
  } catch (error) {
    const aborted = deps.signal?.aborted === true;
    log.error({ err: error }, "eval run failed");
    return fail(
      aborted
        ? "The worker stopped during the run."
        : `The run failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface EvalLoop {
  /** Stops claiming runs; a run in progress stops starting scenarios and is marked failed. */
  stop(): Promise<void>;
}

/** A running run whose heartbeat is older than this died with its worker. */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * The worker's eval loop: claims queued runs one at a time. Polling is enough: a run takes
 * minutes, and the admin shows it queued until then.
 */
export function startEvalLoop(
  deps: Omit<StoredRunDeps, "signal">,
  options: { pollMs?: number } = {},
): EvalLoop {
  const controller = new AbortController();
  const pollMs = options.pollMs ?? 5_000;
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        const now = deps.now();
        const stale = await failStaleEvalRuns(
          deps.db,
          new Date(now.getTime() - STALE_AFTER_MS),
          now,
        );
        if (stale > 0) deps.logger.warn({ runs: stale }, "eval runs abandoned by a stopped worker");
        const run = await claimQueuedEvalRun(deps.db, now);
        if (run) {
          await executeEvalRun({ ...deps, signal: controller.signal }, run);
          continue;
        }
      } catch (error) {
        deps.logger.error({ err: error }, "eval loop error");
      }
      await sleep(pollMs, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  })();
  return {
    async stop() {
      controller.abort();
      await loop;
    },
  };
}
