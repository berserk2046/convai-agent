import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getTemplateVersion } from "@platform/db";
import {
  ODONTOLOGIA_SOURCE,
  createTestDatabase,
  laterVersion,
  odontologiaAt,
  recordPassingEvalRun,
  type TestDatabase,
} from "@platform/db/testing";
import { runEvalSuite } from "@platform/evals";
import { fakeDentalLlm } from "@platform/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** `pnpm template …` as a real process against a test database. */

const run = promisify(execFile);
const CLI = new URL("./template.ts", import.meta.url).pathname;
const VERSION = laterVersion("minor");

let testDb: TestDatabase;
let dir: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "template-cli-"));
  await writeFile(join(dir, "template.yaml"), odontologiaAt(VERSION));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await testDb.drop();
});

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run("node", [CLI, ...args], {
      env: { ...process.env, DATABASE_URL: testDb.url, ANTHROPIC_API_KEY: "", EVAL_LLM: "replay" },
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, out: e.stdout + e.stderr };
  }
}

describe("pnpm template", () => {
  it("validates", async () => {
    expect(await cli("validate", dir)).toMatchObject({
      code: 0,
      out: expect.stringContaining("is valid"),
    });
    const broken = join(dir, "broken.yaml");
    await writeFile(
      broken,
      ODONTOLOGIA_SOURCE.replace("max_reply_words: 60", "max_reply_words: 5"),
    );
    expect(await cli("validate", broken)).toMatchObject({
      code: 1,
      out: expect.stringContaining("agent.max_reply_words"),
    });
  });

  it("pushes a draft, refuses to publish it without evals, publishes once they pass", async () => {
    expect(await cli("push", dir)).toMatchObject({
      code: 0,
      out: expect.stringContaining("as a draft"),
    });
    const refused = await cli("publish", `odontologia@${VERSION}`);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("Run the evals first");
    expect(refused.out).toContain(`pnpm template eval odontologia@${VERSION}`);

    await recordPassingEvalRun(testDb.db, "odontologia", VERSION);
    expect(await cli("publish", `odontologia@${VERSION}`)).toMatchObject({ code: 0 });
    expect((await getTemplateVersion(testDb.db, "odontologia", VERSION))?.status).toBe("published");
  });

  it("live evals need an API key", async () => {
    expect(await cli("eval", dir, "--live")).toMatchObject({
      code: 1,
      out: expect.stringContaining("ANTHROPIC_API_KEY") as unknown,
    });
    expect(await cli("eval", `odontologia@${VERSION}`)).toMatchObject({ code: 1 });
  });

  it("replays recorded evals and prints the report", async () => {
    expect(await cli("eval", dir)).toMatchObject({
      code: 1,
      out: expect.stringContaining("No recordings") as unknown,
    });
    const { recording } = await runEvalSuite({
      serverUrl: testDb.url,
      sourceYaml: odontologiaAt(VERSION),
      mode: "live",
      runs: 1,
      only: ["precio_limpieza", "urgencia"],
      live: fakeDentalLlm(),
      record: true,
      judgeModel: "claude-sonnet-5-5",
    });
    await writeFile(join(dir, "eval-recordings.json"), JSON.stringify(recording));
    const replayed = await cli(
      "eval",
      dir,
      "--only",
      "precio_limpieza,urgencia",
      "--json",
      join(dir, "report.json"),
    );
    expect(replayed.code).toBe(0);
    expect(replayed.out).toMatch(/✓ precio_limpieza\s+critical {2}1\/1/);
    expect(replayed.out).toContain("gate: n/a (--only)");
    // Scenarios without recordings error out, so the full suite fails the gate.
    const full = await cli("eval", dir);
    expect(full.code).toBe(1);
    expect(full.out).toMatch(/! agenda_simple/);
    expect(full.out).toContain("Re-record");
  }, 120_000);
});
