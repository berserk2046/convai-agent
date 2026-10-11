import { evalRuns, finishEvalRun, getEvalRun } from "@platform/db";
import { laterVersion, odontologiaAt } from "@platform/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../actor.ts";
import { ActionRefusedError, ForbiddenError, NotFoundError } from "../errors.ts";
import { createHarness, type Harness } from "../harness.ts";
import { evalRunDetail, requestEvalRun } from "./evals.ts";
import { listTemplates, publishTemplate, templateDetail, uploadTemplate } from "./templates.ts";

let h: Harness;
let owner: Actor;
const NEXT = laterVersion("minor");
const DRAFT = odontologiaAt(NEXT);

beforeAll(async () => {
  h = await createHarness();
  owner = await h.actor("owner@evals.co", { owner: true });
  await uploadTemplate(h.deps, owner, DRAFT);
});

afterAll(async () => {
  await h.close();
});

describe("eval runs from the admin (spec §11)", () => {
  let runId: string;

  it("queues a live run of the current upload, once", async () => {
    ({ runId } = await requestEvalRun(h.deps, owner, "odontologia", NEXT));
    expect(await getEvalRun(h.deps.db, runId)).toMatchObject({
      status: "queued",
      mode: "live",
      runsPerScenario: 3,
      requestedBy: owner.userId,
    });
    await expect(requestEvalRun(h.deps, owner, "odontologia", NEXT)).rejects.toMatchObject({
      code: "already_running",
    });
    const detail = await templateDetail(h.deps, owner, "odontologia", NEXT);
    expect(detail.evals.active?.id).toBe(runId);
    expect(detail.evals.blocker).toMatch(/Run the evals first/);
    expect(detail.scenarios).toHaveLength(15);
  });

  it("shows a failed run's report and blocks publishing with the reason", async () => {
    await h.deps.db.update(evalRuns).set({ status: "running" }).where(eq(evalRuns.id, runId));
    await finishEvalRun(h.deps.db, runId, {
      results: { format: 1, scenarios: [] },
      passRate: 0.95,
      criticalPass: false,
      gatePassed: false,
      costUsd: 0.42,
      now: new Date(),
    });
    const detail = await evalRunDetail(h.deps, owner, runId);
    expect(detail).toMatchObject({
      slug: "odontologia",
      version: NEXT,
      run: { status: "finished", current: true, costUsd: 0.42 },
      report: { format: 1 },
    });
    await expect(publishTemplate(h.deps, owner, "odontologia", NEXT)).rejects.toMatchObject({
      code: "evals_required",
      message: expect.stringMatching(/critical eval failed/) as unknown,
    });
  });

  it("treats runs of an earlier upload of the draft as stale", async () => {
    await h.deps.db
      .update(evalRuns)
      .set({ gatePassed: true, criticalPass: true })
      .where(eq(evalRuns.id, runId));
    await uploadTemplate(h.deps, owner, DRAFT.replace("Nada más.", "Solo eso."));
    const detail = await templateDetail(h.deps, owner, "odontologia", NEXT);
    expect(detail.evals.runs[0]).toMatchObject({ id: runId, current: false });
    expect(detail.evals.blocker).toMatch(/Run the evals first/);
    await expect(publishTemplate(h.deps, owner, "odontologia", NEXT)).rejects.toBeInstanceOf(
      ActionRefusedError,
    );
    const versions = (await listTemplates(h.deps, owner))[0]?.versions;
    expect(versions?.find((v) => v.version === NEXT)?.evalGatePassed).toBeNull();
  });

  it("is for the platform owner only", async () => {
    const admin = await h.actor("admin@evals.co", { business: h.a });
    await expect(requestEvalRun(h.deps, admin, "odontologia", NEXT)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(evalRunDetail(h.deps, admin, runId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(evalRunDetail(h.deps, owner, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });
});
