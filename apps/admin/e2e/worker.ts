import {
  claimQueuedEvalRun,
  createDb,
  finishEvalRun,
  getTemplateVersion,
  setTemplateEvalReport,
} from "@platform/db";
import type { EvalReport } from "@platform/evals";

/**
 * Plays the worker for the smoke test: claims the eval run the owner queued and finishes
 * it with a passing report, as a live run where every scenario passed would. Real eval
 * runs (scratch databases, the agent, the judge) are covered by @platform/evals' tests.
 */
export async function finishQueuedEvalRun(): Promise<void> {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "");
  try {
    const run = await claimQueuedEvalRun(db, new Date());
    if (!run) throw new Error("no queued eval run");
    const template = await getTemplateVersion(db, run.templateSlug, run.templateVersion);
    if (!template) throw new Error("the template is gone");
    const now = new Date().toISOString();
    const usage = { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0 };
    const scenarios = template.manifest.evals.map((scenario) => ({
      id: scenario.id,
      critical: scenario.critical,
      passedRuns: run.runsPerScenario,
      runs: Array.from({ length: run.runsPerScenario }, (_, i) => ({
        run: i + 1,
        status: "passed" as const,
        error: null,
        assertions: [{ name: "reply_contains", passed: true, detail: "as expected" }],
        transcript: scenario.turns.flatMap((t) =>
          t.user === undefined
            ? []
            : [
                {
                  at: "2026-10-05T09:00:00.000-05:00",
                  user: t.user,
                  replies: [],
                  toolCalls: [],
                  costUsd: 0.001,
                },
              ],
        ),
        finalState: null,
        usage,
        costUsd: 0.001,
        durationMs: 1500,
        logs: [],
      })),
    }));
    const total = scenarios.length * run.runsPerScenario;
    const report: EvalReport = {
      format: 1,
      template: {
        slug: run.templateSlug,
        version: run.templateVersion,
        sourceSha256: run.sourceSha256,
      },
      mode: "live",
      runsPerScenario: run.runsPerScenario,
      only: null,
      agentModel: template.manifest.agent.model,
      judgeModel: "claude-sonnet-5-5",
      startedAt: now,
      finishedAt: now,
      summary: {
        totalRuns: total,
        passedRuns: total,
        passRate: 1,
        criticalPass: true,
        failingCritical: [],
        gatePassed: true,
      },
      usage,
      costUsd: total * 0.001,
      scenarios,
    };
    await finishEvalRun(db, run.id, {
      results: report,
      passRate: 1,
      criticalPass: true,
      gatePassed: true,
      costUsd: report.costUsd,
      now: new Date(),
    });
    await setTemplateEvalReport(db, run.templateSlug, run.templateVersion, {
      run_id: run.id,
      gate_passed: true,
      source_sha256: run.sourceSha256,
    });
  } finally {
    await close();
  }
}
