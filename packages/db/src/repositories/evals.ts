import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { evalRuns, verticalTemplates, type EvalMode, type EvalRunRow } from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

/**
 * Eval runs (spec §11, ADR 0015). The admin queues a live run, the worker claims and runs
 * it; the CLI inserts runs it executes itself. The publish gate reads finished runs.
 */

/** Which upload of a version was evaluated: a re-uploaded draft makes older runs stale. */
export function sourceSha256(sourceYaml: string): string {
  return createHash("sha256").update(sourceYaml).digest("hex");
}

export interface NewEvalRun {
  templateSlug: string;
  templateVersion: string;
  sourceSha256: string;
  mode: EvalMode;
  runsPerScenario: number;
  requestedBy: string | null;
  /** "running" for a run the caller executes right away (CLI). */
  status?: "queued" | "running";
  now: Date;
}

export async function insertEvalRun(db: Executor, input: NewEvalRun): Promise<EvalRunRow> {
  const running = input.status === "running";
  const [row] = await db
    .insert(evalRuns)
    .values({
      templateSlug: input.templateSlug,
      templateVersion: input.templateVersion,
      sourceSha256: input.sourceSha256,
      mode: input.mode,
      runsPerScenario: input.runsPerScenario,
      requestedBy: input.requestedBy,
      status: input.status ?? "queued",
      createdAt: input.now,
      ...(running ? { startedAt: input.now, heartbeatAt: input.now } : {}),
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/** A queued or running run of this exact upload, if any. */
export async function findActiveEvalRun(
  db: Executor,
  slug: string,
  version: string,
  sha: string,
): Promise<EvalRunRow | null> {
  const [row] = await db
    .select()
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.templateSlug, slug),
        eq(evalRuns.templateVersion, version),
        eq(evalRuns.sourceSha256, sha),
        inArray(evalRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The oldest queued run, now marked running; null when there is none. Safe with many workers. */
export async function claimQueuedEvalRun(db: Executor, now: Date): Promise<EvalRunRow | null> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE eval_runs SET status = 'running', started_at = ${now}, heartbeat_at = ${now}
    WHERE id = (
      SELECT id FROM eval_runs WHERE status = 'queued'
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id`);
  const id = result.rows[0]?.id;
  return id ? getEvalRun(db, id) : null;
}

export async function touchEvalRun(
  db: Executor,
  id: string,
  progress: { done: number; total: number },
  now: Date,
): Promise<void> {
  await db
    .update(evalRuns)
    .set({ progress, heartbeatAt: now })
    .where(and(eq(evalRuns.id, id), eq(evalRuns.status, "running")));
}

export interface FinishedEvalRun {
  results: unknown;
  passRate: number;
  criticalPass: boolean;
  gatePassed: boolean;
  costUsd: number;
  now: Date;
}

export async function finishEvalRun(
  db: Executor,
  id: string,
  outcome: FinishedEvalRun,
): Promise<EvalRunRow> {
  const [row] = await db
    .update(evalRuns)
    .set({
      status: "finished",
      results: outcome.results,
      passRate: outcome.passRate,
      criticalPass: outcome.criticalPass,
      gatePassed: outcome.gatePassed,
      costUsd: outcome.costUsd,
      finishedAt: outcome.now,
      heartbeatAt: outcome.now,
    })
    .where(eq(evalRuns.id, id))
    .returning();
  if (!row) throw new Error(`eval run ${id} not found`);
  return row;
}

/** The run couldn't complete (no API key, the draft changed, the worker stopped…). */
export async function failEvalRun(
  db: Executor,
  id: string,
  error: string,
  now: Date,
  costUsd = 0,
): Promise<void> {
  await db
    .update(evalRuns)
    .set({ status: "error", error: error.slice(0, 2000), finishedAt: now, costUsd })
    .where(eq(evalRuns.id, id));
}

/** Running runs whose heartbeat stopped before `staleBefore` (a worker died mid-run). */
export async function failStaleEvalRuns(
  db: Executor,
  staleBefore: Date,
  now: Date,
): Promise<number> {
  const rows = await db
    .update(evalRuns)
    .set({ status: "error", error: "The worker stopped during the run.", finishedAt: now })
    .where(and(eq(evalRuns.status, "running"), lt(evalRuns.heartbeatAt, staleBefore)))
    .returning({ id: evalRuns.id });
  return rows.length;
}

export async function getEvalRun(db: Executor, id: string): Promise<EvalRunRow | null> {
  const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, id));
  return row ?? null;
}

/** A run without its (large) results, for lists. */
export type EvalRunSummaryRow = Omit<EvalRunRow, "results">;

const summaryColumns = {
  id: evalRuns.id,
  templateSlug: evalRuns.templateSlug,
  templateVersion: evalRuns.templateVersion,
  sourceSha256: evalRuns.sourceSha256,
  configSource: evalRuns.configSource,
  mode: evalRuns.mode,
  runsPerScenario: evalRuns.runsPerScenario,
  status: evalRuns.status,
  progress: evalRuns.progress,
  passRate: evalRuns.passRate,
  criticalPass: evalRuns.criticalPass,
  gatePassed: evalRuns.gatePassed,
  costUsd: evalRuns.costUsd,
  error: evalRuns.error,
  requestedBy: evalRuns.requestedBy,
  createdAt: evalRuns.createdAt,
  startedAt: evalRuns.startedAt,
  finishedAt: evalRuns.finishedAt,
  heartbeatAt: evalRuns.heartbeatAt,
};

/** Newest first. */
export async function listEvalRuns(
  db: Executor,
  slug: string,
  version: string,
  limit = 20,
): Promise<EvalRunSummaryRow[]> {
  return db
    .select(summaryColumns)
    .from(evalRuns)
    .where(and(eq(evalRuns.templateSlug, slug), eq(evalRuns.templateVersion, version)))
    .orderBy(desc(evalRuns.createdAt))
    .limit(limit);
}

/** The newest finished run of this exact upload in `mode`. */
export async function latestFinishedEvalRun(
  db: Executor,
  slug: string,
  version: string,
  sha: string,
  mode: EvalMode,
): Promise<EvalRunSummaryRow | null> {
  const [row] = await db
    .select(summaryColumns)
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.templateSlug, slug),
        eq(evalRuns.templateVersion, version),
        eq(evalRuns.sourceSha256, sha),
        eq(evalRuns.mode, mode),
        eq(evalRuns.status, "finished"),
      ),
    )
    .orderBy(desc(evalRuns.finishedAt))
    .limit(1);
  return row ?? null;
}

/**
 * The version's latest eval summary, kept on the template row for list views
 * (`vertical_templates.eval_report`, spec §6).
 */
export async function setTemplateEvalReport(
  db: Executor,
  slug: string,
  version: string,
  report: Record<string, unknown>,
): Promise<void> {
  await db
    .update(verticalTemplates)
    .set({ evalReport: report })
    .where(and(eq(verticalTemplates.slug, slug), eq(verticalTemplates.version, version)));
}
