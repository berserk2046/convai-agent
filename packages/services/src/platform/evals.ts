import {
  findActiveEvalRun,
  getEvalRun,
  getTemplateVersion,
  insertEvalRun,
  latestFinishedEvalRun,
  listEvalRuns,
  recordAudit,
  sourceSha256,
  type EvalRunSummaryRow,
} from "@platform/db";
import { LIVE_RUNS_PER_SCENARIO, publishBlocker, type EvalReport } from "@platform/evals";
import { requireOwner, type Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { ActionRefusedError, NotFoundError, requireIds } from "../errors.ts";

/**
 * Eval runs from the admin (spec §11, §12; ADR 0015): the owner queues a live run of a
 * version's current upload, the worker runs it, the version page shows the report, and
 * publishing waits for a run that passes the gate (spec §10).
 */

export interface EvalRunSummary {
  id: string;
  mode: string;
  runsPerScenario: number;
  status: string;
  progress: { done: number; total: number } | null;
  passRate: number | null;
  criticalPass: boolean | null;
  gatePassed: boolean | null;
  costUsd: number;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** It evaluated the version's current upload (a re-uploaded draft makes runs stale). */
  current: boolean;
}

export interface TemplateEvals {
  /** Newest first. */
  runs: EvalRunSummary[];
  /** A queued or running run of the current upload. */
  active: EvalRunSummary | null;
  /** Why the current upload can't be published yet; null when the gate is met. */
  blocker: string | null;
}

/** The eval side of a version's page. */
export async function templateEvals(
  deps: ServiceDeps,
  slug: string,
  version: string,
  sourceYaml: string,
): Promise<TemplateEvals> {
  const sha = sourceSha256(sourceYaml);
  const runs = (await listEvalRuns(deps.db, slug, version)).map((r) => summary(r, sha));
  return {
    runs,
    active:
      runs.find((r) => r.current && (r.status === "queued" || r.status === "running")) ?? null,
    blocker: await gateBlocker(deps, slug, version, sha),
  };
}

/** The publish gate for the current upload of slug@version: null when it may be published. */
export async function gateBlocker(
  deps: Pick<ServiceDeps, "db">,
  slug: string,
  version: string,
  sha: string,
): Promise<string | null> {
  return publishBlocker(await latestFinishedEvalRun(deps.db, slug, version, sha, "live"));
}

/** Queues a live run (3 per scenario) of the version's current upload for the worker. */
export async function requestEvalRun(
  deps: ServiceDeps,
  actor: Actor,
  slug: string,
  version: string,
): Promise<{ runId: string }> {
  requireOwner(actor);
  const row = await getTemplateVersion(deps.db, slug, version);
  if (!row) throw new NotFoundError("template");
  if (row.status === "deprecated") {
    throw new ActionRefusedError("deprecated", `${slug}@${version} is deprecated.`);
  }
  const sha = sourceSha256(row.sourceYaml);
  if (await findActiveEvalRun(deps.db, slug, version, sha)) {
    throw new ActionRefusedError(
      "already_running",
      "An eval run of this upload is already queued.",
    );
  }
  const run = await insertEvalRun(deps.db, {
    templateSlug: slug,
    templateVersion: version,
    sourceSha256: sha,
    mode: "live",
    runsPerScenario: LIVE_RUNS_PER_SCENARIO,
    requestedBy: actor.userId,
    now: deps.now(),
  });
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId: null,
    action: "template.eval",
    payload: { slug, version, run_id: run.id },
  });
  return { runId: run.id };
}

export interface EvalRunDetail {
  slug: string;
  version: string;
  run: EvalRunSummary;
  /** Null until the run finishes. */
  report: EvalReport | null;
}

export async function evalRunDetail(
  deps: ServiceDeps,
  actor: Actor,
  runId: string,
): Promise<EvalRunDetail> {
  requireOwner(actor);
  requireIds("eval run", runId);
  const run = await getEvalRun(deps.db, runId);
  if (!run) throw new NotFoundError("eval run");
  const template = await getTemplateVersion(deps.db, run.templateSlug, run.templateVersion);
  const sha = template ? sourceSha256(template.sourceYaml) : "";
  return {
    slug: run.templateSlug,
    version: run.templateVersion,
    run: summary(run, sha),
    report: run.status === "finished" ? (run.results as EvalReport | null) : null,
  };
}

function summary(row: EvalRunSummaryRow, currentSha: string): EvalRunSummary {
  return {
    id: row.id,
    mode: row.mode,
    runsPerScenario: row.runsPerScenario,
    status: row.status,
    progress: row.progress ?? null,
    passRate: row.passRate,
    criticalPass: row.criticalPass,
    gatePassed: row.gatePassed,
    costUsd: row.costUsd,
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    current: row.sourceSha256 === currentSha,
  };
}
