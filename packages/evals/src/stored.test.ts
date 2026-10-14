import {
  createUser,
  dropScratchDatabase,
  createScratchDatabase,
  getEvalRun,
  getTemplateVersion,
  insertEvalRun,
  insertPlaygroundSession,
  getPlaygroundSession,
  listScratchDatabases,
  scratchDatabaseName,
  sourceSha256,
  touchEvalRun,
  evalRuns,
  type EvalRunRow,
} from "@platform/db";
import {
  ODONTOLOGIA_SCENARIOS,
  ODONTOLOGIA_VERSION,
  createTestDatabase,
  publishOdontologia,
  type TestDatabase,
} from "@platform/db/testing";
import { createLogger } from "@platform/shared";
import { eq } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupSandboxes } from "./cleanup.ts";
import { executeEvalRun, startEvalLoop, type StoredRunDeps } from "./stored.ts";
import { fakeDentalLlm } from "./testing.ts";

let testDb: TestDatabase;
let sha: string;
const logger = createLogger({ level: "silent" });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const row = await publishOdontologia(testDb.db);
  sha = sourceSha256(row.sourceYaml);
});

afterAll(async () => {
  await testDb.drop();
});

function deps(overrides: Partial<StoredRunDeps> = {}): StoredRunDeps {
  return {
    db: testDb.db,
    databaseUrl: testDb.url,
    logger,
    llm: fakeDentalLlm(),
    judgeModel: "claude-sonnet-5-5",
    now: () => new Date(),
    concurrency: 5,
    ...overrides,
  };
}

const queue = (overrides: Partial<Parameters<typeof insertEvalRun>[1]> = {}) =>
  insertEvalRun(testDb.db, {
    templateSlug: "odontologia",
    templateVersion: ODONTOLOGIA_VERSION,
    sourceSha256: sha,
    mode: "live",
    runsPerScenario: 1,
    requestedBy: null,
    now: new Date(),
    ...overrides,
  });

describe("stored eval runs", () => {
  it("runs every scenario and stores the report, the gate and a summary on the template", async () => {
    const run = await queue({ status: "running" });
    const finished = await executeEvalRun(deps(), run);
    expect(finished).toMatchObject({ status: "finished", criticalPass: false, gatePassed: false });
    const report = finished?.results as { scenarios: unknown[]; summary: { totalRuns: number } };
    const count = ODONTOLOGIA_SCENARIOS;
    expect(report.scenarios).toHaveLength(count);
    expect(finished?.progress).toEqual({ done: count, total: count });
    expect(finished?.costUsd).toBeGreaterThan(0);
    const template = await getTemplateVersion(testDb.db, "odontologia", ODONTOLOGIA_VERSION);
    expect(template?.evalReport).toMatchObject({
      run_id: run.id,
      mode: "live",
      gate_passed: false,
    });
  }, 120_000);

  it("fails with a clear reason when it can't run", async () => {
    const noKey = await executeEvalRun(deps({ llm: null }), await queue({ status: "running" }));
    expect(noKey).toBeNull();
    const stale = await queue({ status: "running", sourceSha256: "0".repeat(64) });
    await executeEvalRun(deps(), stale);
    expect(await getEvalRun(testDb.db, stale.id)).toMatchObject({
      status: "error",
      error: expect.stringMatching(/uploaded again/) as unknown,
    });
  });

  it("the loop claims queued runs and fails runs whose worker died", async () => {
    const abandoned = await queue({ status: "running", now: new Date(Date.now() - 60 * 60_000) });
    const queued = await queue({ runsPerScenario: 1 });
    const loop = startEvalLoop({ ...deps(), llm: null }, { pollMs: 20 });
    let row: EvalRunRow | null = null;
    for (let i = 0; i < 200; i += 1) {
      row = await getEvalRun(testDb.db, queued.id);
      if (row?.status === "error") break;
      await sleep(25);
    }
    await loop.stop();
    expect(row).toMatchObject({
      status: "error",
      error: expect.stringMatching(/ANTHROPIC_API_KEY/) as unknown,
    });
    expect(await getEvalRun(testDb.db, abandoned.id)).toMatchObject({
      status: "error",
      error: "The worker stopped during the run.",
    });
  });

  it("only heartbeats a running run", async () => {
    const run = await queue();
    await touchEvalRun(testDb.db, run.id, { done: 1, total: 2 }, new Date());
    expect((await getEvalRun(testDb.db, run.id))?.progress).toBeNull();
    await testDb.db.update(evalRuns).set({ status: "error" }).where(eq(evalRuns.id, run.id));
  });
});

describe("sandbox cleanup", () => {
  it("closes idle playground sessions and drops scratch databases nothing uses", async () => {
    const owner = await createUser(testDb.db, {
      email: "owner@cleanup.test",
      name: "Owner",
      passwordHash: "x",
      isPlatformOwner: true,
    });
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
    const names = {
      idle: scratchDatabaseName("play", dayAgo),
      active: scratchDatabaseName("play", dayAgo),
      orphan: scratchDatabaseName("play", dayAgo),
      fresh: scratchDatabaseName("play"),
      oldEval: scratchDatabaseName("eval", dayAgo),
    };
    for (const name of Object.values(names)) await createScratchDatabase(testDb.url, name);
    const session = (databaseName: string, at: Date) =>
      insertPlaygroundSession(testDb.db, {
        ownerUserId: owner.id,
        databaseName,
        templateSlug: "odontologia",
        templateVersion: ODONTOLOGIA_VERSION,
        sourceBusinessId: null,
        consentGiven: true,
        entries: [],
        now: at,
      });
    const idle = await session(names.idle, dayAgo);
    const active = await session(names.active, new Date());
    try {
      const result = await cleanupSandboxes({
        db: testDb.db,
        databaseUrl: testDb.url,
        logger,
        now: () => new Date(),
      });
      expect(result.closedSessions).toBe(1);
      expect((await getPlaygroundSession(testDb.db, idle.id))?.status).toBe("closed");
      expect((await getPlaygroundSession(testDb.db, active.id))?.status).toBe("active");
      // Other test files create scratch databases meanwhile: look only at these.
      const left = new Set([
        ...(await listScratchDatabases(testDb.url, "play")),
        ...(await listScratchDatabases(testDb.url, "eval")),
      ]);
      expect(
        Object.entries(names)
          .filter(([, name]) => left.has(name))
          .map(([key]) => key),
      ).toEqual(["active", "fresh"]);
    } finally {
      for (const name of Object.values(names)) await dropScratchDatabase(testDb.url, name);
    }
  });
});
