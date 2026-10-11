import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  createDb,
  getTemplateVersion,
  insertEvalRun,
  sourceSha256,
  type Database,
} from "@platform/db";
import {
  LIVE_RUNS_PER_SCENARIO,
  executeEvalRun,
  parseRecordingFile,
  runEvalSuite,
  type EvalReport,
} from "@platform/evals";
import { createAnthropicLlm, isKnownModel, type LlmClient } from "@platform/llm";
import { agentEnv, baseEnv, createLogger, databaseEnv, evalsEnv, parseEnv } from "@platform/shared";
import { validateTemplateSource, type Issue, type Template } from "@platform/templates";
import { ActionRefusedError } from "../errors.ts";
import { gateBlocker } from "../platform/evals.ts";
import { publishVersion, uploadVersion } from "../platform/templates.ts";

/**
 * `pnpm template …` (spec §10 CLI): validate, eval, push and publish vertical templates.
 * Runs on the server (or a laptop) with database access; there's no login, and every
 * change is audited with `via: "cli"`. Reads the root .env like the API and the worker.
 */

const USAGE = `Usage: pnpm template <command> [options]

Commands:
  validate <path> [--previous <path>]
      Validate a template (a file, or a directory with template.yaml). --previous checks
      the upgrade rules against an older version.

  eval <path> [--only <id,…>] [--live | --replay] [--runs <n>] [--record]
              [--max-cost <usd>] [--concurrency <n>] [--json <file>]
      Run the template's evals in a scratch database. The model's answers come from the
      recordings next to the template (replay, the default, set by EVAL_LLM) or from the
      API (--live, needs ANTHROPIC_API_KEY; 3 runs per scenario unless --runs). --record
      writes <dir>/eval-recordings.json from a live run. --max-cost stops starting
      scenarios once a live run has spent that much (runs in flight still finish).

  eval <slug>@<version> [--runs <n>]
      Live evals of the uploaded version, saved for the publish gate (like "Run evals" in
      the admin).

  push <path>
      Upload a template as a draft (re-uploading a draft replaces it).

  publish <slug>@<version>
      Publish a draft. Needs a live eval run of this upload that passes the gate: every
      critical scenario passes all 3 runs and at least 90% of runs pass.`;

const RECORDINGS_FILE = "eval-recordings.json";

const cliEnv = baseEnv.extend(databaseEnv.shape).extend(agentEnv.shape).extend(evalsEnv.shape);
type CliEnv = ReturnType<typeof parseEnv<typeof cliEnv>>;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      previous: { type: "string" },
      only: { type: "string", multiple: true },
      live: { type: "boolean" },
      replay: { type: "boolean" },
      runs: { type: "string" },
      record: { type: "boolean" },
      concurrency: { type: "string" },
      json: { type: "string" },
      "max-cost": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, target] = positionals;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (command === undefined || target === undefined) {
    console.error(USAGE);
    return 1;
  }
  switch (command) {
    case "validate":
      return validate(target, values.previous);
    case "eval":
      return isVersionRef(target)
        ? evalStored(target, numberOption(values.runs, "runs"))
        : evalFile(target, {
            only: (values.only ?? []).flatMap((o) => o.split(",")).filter(Boolean),
            mode: values.live ? "live" : values.replay ? "replay" : undefined,
            runs: numberOption(values.runs, "runs"),
            record: values.record === true,
            concurrency: numberOption(values.concurrency, "concurrency"),
            json: values.json,
            maxCost: costOption(values["max-cost"]),
          });
    case "push":
      return push(target);
    case "publish":
      return publish(target);
    default:
      console.error(USAGE);
      return 1;
  }
}

// --- validate ----------------------------------------------------------------------------

async function validate(path: string, previousPath: string | undefined): Promise<number> {
  const file = await resolveTemplateFile(path);
  const previous = previousPath === undefined ? undefined : await loadTemplate(previousPath);
  if (previous === null) return 1;
  const report = validateTemplateSource(await readFile(file, "utf8"), previous ? { previous } : {});
  printIssues(file, report.issues);
  if (!report.ok) return 1;
  const t = report.template;
  console.log(`✓ ${file}: ${t ? `${t.manifest.slug}@${t.manifest.version} ` : ""}is valid`);
  return 0;
}

// --- eval --------------------------------------------------------------------------------

interface EvalFileOptions {
  only: string[];
  mode: "live" | "replay" | undefined;
  runs: number | undefined;
  record: boolean;
  concurrency: number | undefined;
  json: string | undefined;
  maxCost: number | undefined;
}

async function evalFile(path: string, options: EvalFileOptions): Promise<number> {
  const env = parseEnv(cliEnv);
  const file = await resolveTemplateFile(path);
  const sourceYaml = await readFile(file, "utf8");
  const parsed = validateTemplateSource(sourceYaml);
  if (!parsed.ok || !parsed.template) {
    printIssues(file, parsed.issues);
    return 1;
  }
  const mode = options.mode ?? env.EVAL_LLM;
  const recordingsPath = join(dirname(file), RECORDINGS_FILE);
  if (options.record && mode !== "live") {
    console.error("--record needs --live: recordings come from the API.");
    return 1;
  }
  const live = mode === "live" ? liveLlm(env) : undefined;
  if (mode === "live" && !live) return 1;
  if (!judgeModelOk(env.JUDGE_MODEL)) return 1;
  const recordings = mode === "replay" ? await readRecordings(recordingsPath) : null;
  if (mode === "replay" && !recordings) return 1;

  const runs = options.runs ?? (mode === "live" ? LIVE_RUNS_PER_SCENARIO : 1);
  const label = `${parsed.template.manifest.slug}@${parsed.template.manifest.version}`;
  console.log(
    `Evaluating ${label} (${mode}, ${String(runs)} run(s) per scenario` +
      `${options.maxCost === undefined ? "" : `, stopping at $${options.maxCost.toFixed(2)}`})…`,
  );
  const budget = new AbortController();
  let spent = 0;
  const suite = runEvalSuite({
    serverUrl: env.DATABASE_URL,
    sourceYaml,
    mode,
    runs,
    ...(options.only.length > 0 ? { only: options.only } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(live ? { live } : {}),
    recordings,
    record: options.record,
    judgeModel: env.JUDGE_MODEL,
    signal: budget.signal,
    onProgress: (done, total, costUsd) => {
      spent = costUsd;
      process.stdout.write(
        `\r  ${String(done)}/${String(total)} scenario runs, $${costUsd.toFixed(4)} spent`,
      );
      if (options.maxCost !== undefined && costUsd >= options.maxCost) budget.abort();
    },
  });
  const outcome = await suite.catch((error: unknown) => {
    if (!budget.signal.aborted) throw error;
    return null;
  });
  process.stdout.write("\n\n");
  if (!outcome) {
    console.error(
      `✗ Stopped at the cost cap: $${spent.toFixed(4)} spent (cap $${String(options.maxCost)}).`,
    );
    return 1;
  }
  const { report, recording } = outcome;
  printReport(report);
  if (options.json) {
    await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report written to ${options.json}`);
  }
  if (recording) {
    await writeFile(recordingsPath, `${JSON.stringify(recording, null, 2)}\n`);
    console.log(`Recordings written to ${recordingsPath}`);
  }
  const passed =
    options.only.length > 0
      ? report.summary.passedRuns === report.summary.totalRuns
      : report.summary.gatePassed;
  return passed ? 0 : 1;
}

async function evalStored(ref: string, runs: number | undefined): Promise<number> {
  const env = parseEnv(cliEnv);
  const llm = liveLlm(env);
  if (!llm || !judgeModelOk(env.JUDGE_MODEL)) return 1;
  return withDatabase(env, async (db) => {
    const { slug, version } = parseRef(ref);
    const template = await getTemplateVersion(db, slug, version);
    if (!template) {
      console.error(`${ref} is not uploaded. Upload it first: pnpm template push <path>`);
      return 1;
    }
    const run = await insertEvalRun(db, {
      templateSlug: slug,
      templateVersion: version,
      sourceSha256: sourceSha256(template.sourceYaml),
      mode: "live",
      runsPerScenario: runs ?? LIVE_RUNS_PER_SCENARIO,
      requestedBy: null,
      status: "running",
      now: new Date(),
    });
    console.log(`Evaluating ${ref} (live, saved as eval run ${run.id})…`);
    const finished = await executeEvalRun(
      {
        db,
        databaseUrl: env.DATABASE_URL,
        logger: createLogger({ level: env.LOG_LEVEL === "info" ? "warn" : env.LOG_LEVEL }),
        llm,
        judgeModel: env.JUDGE_MODEL,
        now: () => new Date(),
      },
      run,
    );
    if (!finished) {
      console.error("The eval run failed; see the error above.");
      return 1;
    }
    printReport(finished.results as EvalReport);
    return finished.gatePassed ? 0 : 1;
  });
}

// --- push and publish --------------------------------------------------------------------------

async function push(path: string): Promise<number> {
  const env = parseEnv(cliEnv);
  const file = await resolveTemplateFile(path);
  const sourceYaml = await readFile(file, "utf8");
  return withDatabase(env, async (db) => {
    const result = await uploadVersion({ db }, { cli: true }, sourceYaml);
    if (!result.ok) {
      printIssues(file, result.issues);
      return 1;
    }
    printIssues(file, result.warnings);
    console.log(`✓ uploaded ${result.slug}@${result.version} as a draft`);
    console.log(`  Next: pnpm template eval ${result.slug}@${result.version}, then publish.`);
    return 0;
  });
}

async function publish(ref: string): Promise<number> {
  const env = parseEnv(cliEnv);
  return withDatabase(env, async (db) => {
    const { slug, version } = parseRef(ref);
    try {
      await publishVersion({ db }, { cli: true }, slug, version);
    } catch (error) {
      if (!(error instanceof ActionRefusedError)) throw error;
      console.error(`✗ ${ref} was not published: ${error.message}`);
      const template = await getTemplateVersion(db, slug, version);
      if (error.code === "evals_required" && template) {
        const blocker = await gateBlocker({ db }, slug, version, sourceSha256(template.sourceYaml));
        if (blocker?.startsWith("Run the evals")) console.error(`  Run: pnpm template eval ${ref}`);
      }
      return 1;
    }
    console.log(`✓ published ${ref}`);
    return 0;
  });
}

// --- helpers -------------------------------------------------------------------------------------

function liveLlm(env: CliEnv): LlmClient | undefined {
  if (!env.ANTHROPIC_API_KEY) {
    console.error("Live evals need ANTHROPIC_API_KEY (in the environment or the root .env).");
    return undefined;
  }
  return createAnthropicLlm({ apiKey: env.ANTHROPIC_API_KEY });
}

function judgeModelOk(model: string): boolean {
  if (isKnownModel(model)) return true;
  console.error(`JUDGE_MODEL "${model}" has no price in @platform/llm (MODEL_PRICES).`);
  return false;
}

async function readRecordings(path: string) {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) {
    console.error(`No recordings at ${path}. Make them with --live --record.`);
    return null;
  }
  const recordings = parseRecordingFile(JSON.parse(text));
  if (!recordings) console.error(`${path} is not an eval recordings file.`);
  return recordings;
}

async function withDatabase(env: CliEnv, work: (db: Database) => Promise<number>): Promise<number> {
  const handle = createDb(env.DATABASE_URL, { maxConnections: 4 });
  try {
    return await work(handle.db);
  } finally {
    await handle.close();
  }
}

function isVersionRef(target: string): boolean {
  return /^[a-z0-9_]+@\d+\.\d+\.\d+$/.test(target);
}

function parseRef(ref: string): { slug: string; version: string } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) throw new Error(`"${ref}" should look like odontologia@1.2.0`);
  return { slug: ref.slice(0, at), version: ref.slice(at + 1) };
}

function costOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("--max-cost must be a positive amount in USD");
  return n;
}

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error(`--${name} must be 1 to 10`);
  return n;
}

async function resolveTemplateFile(path: string): Promise<string> {
  const info = await stat(path);
  return info.isDirectory() ? join(path, "template.yaml") : path;
}

async function loadTemplate(path: string): Promise<Template | null> {
  const file = await resolveTemplateFile(path);
  const report = validateTemplateSource(await readFile(file, "utf8"));
  if (!report.template || !report.ok) {
    console.error(`✗ --previous ${file} is not a valid template itself:`);
    printIssues(file, report.issues);
    return null;
  }
  return report.template;
}

function printIssues(file: string, issues: readonly Issue[]): void {
  const sorted = [...issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1,
  );
  for (const issue of sorted) {
    const where = `${file}${issue.line === undefined ? "" : `:${String(issue.line)}`}`;
    const label = issue.severity === "error" ? "error" : "warning";
    console.log(`${label}  ${issue.path || "(document)"}  ${issue.message}\n        at ${where}`);
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  if (issues.length > 0) {
    console.log(`\n${String(errors)} error(s), ${String(issues.length - errors)} warning(s)`);
  }
}

/** One line per scenario, the first problem of each failing run, then the gate. */
export function reportText(report: EvalReport): string {
  const lines: string[] = [];
  const width = Math.max(...report.scenarios.map((s) => s.id.length), 8);
  for (const scenario of report.scenarios) {
    const all = scenario.passedRuns === scenario.runs.length;
    const errored = scenario.runs.some((r) => r.status === "error");
    const mark = all ? "✓" : errored ? "!" : "✗";
    lines.push(
      `${mark} ${scenario.id.padEnd(width)}  ${scenario.critical ? "critical" : "        "}  ` +
        `${String(scenario.passedRuns)}/${String(scenario.runs.length)}`,
    );
    for (const run of scenario.runs) {
      if (run.status === "passed") continue;
      const failed = run.assertions.find((a) => !a.passed);
      const why = run.error ?? (failed ? `${failed.name}: ${failed.detail}` : "failed");
      lines.push(`    run ${String(run.run)}: ${why}`);
    }
  }
  const s = report.summary;
  const percent = `${(s.passRate * 100).toFixed(0)}%`;
  const critical = s.criticalPass ? "all passed" : `failed (${s.failingCritical.join(", ")})`;
  const gate = report.only ? "n/a (--only)" : s.gatePassed ? "PASSED" : "FAILED";
  lines.push(
    "",
    `Pass rate ${percent} (${String(s.passedRuns)}/${String(s.totalRuns)}) · critical: ${critical} · ` +
      `gate: ${gate} · cost $${report.costUsd.toFixed(4)} (${report.mode})`,
  );
  return lines.join("\n");
}

function printReport(report: EvalReport): void {
  console.log(reportText(report));
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  });
}
