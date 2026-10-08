import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Issue } from "../issues.ts";
import type { Template } from "../meta-schema.ts";
import { validateTemplateSource } from "../validate/index.ts";

const USAGE = `Usage: pnpm template <command> [options]

Commands:
  validate <path> [--previous <path>]   Validate a template (file or directory with template.yaml).
                                        --previous checks upgrade rules against an older version.

Coming later: eval (M6), push and publish (M6).`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { previous: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [command, path] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  if (command !== "validate" || path === undefined) {
    console.error(USAGE);
    return 1;
  }

  const file = await resolveTemplateFile(path);
  const previous = values.previous === undefined ? undefined : await loadPrevious(values.previous);
  if (previous === null) return 1;

  const report = validateTemplateSource(await readFile(file, "utf8"), previous ? { previous } : {});
  printIssues(file, report.issues);
  if (report.ok) {
    const t = report.template;
    console.log(`✓ ${file}: ${t ? `${t.manifest.slug}@${t.manifest.version} ` : ""}is valid`);
    return 0;
  }
  return 1;
}

async function resolveTemplateFile(path: string): Promise<string> {
  const info = await stat(path);
  return info.isDirectory() ? join(path, "template.yaml") : path;
}

async function loadPrevious(path: string): Promise<Template | null> {
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
    const where = `${file}${issue.line === undefined ? "" : `:${issue.line}`}`;
    const label = issue.severity === "error" ? "error" : "warning";
    console.log(`${label}  ${issue.path || "(document)"}  ${issue.message}\n        at ${where}`);
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  if (issues.length > 0) console.log(`\n${errors} error(s), ${issues.length - errors} warning(s)`);
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
