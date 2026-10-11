import { readFileSync } from "node:fs";
import { parseSemver, validateTemplateSource } from "@platform/templates";
import type { Executor } from "../tenant.ts";
import { createBusiness } from "./businesses.ts";
import { finishEvalRun, insertEvalRun, sourceSha256 } from "./evals.ts";
import { getTemplateVersion, saveTemplateDraft, setTemplateStatus } from "./templates.ts";

/** templates/odontologia/template.yaml (Appendix A), for tests. */
export const ODONTOLOGIA_SOURCE = readFileSync(
  new URL("../../../../templates/odontologia/template.yaml", import.meta.url),
  "utf8",
);

export async function publishOdontologia(db: Executor, source = ODONTOLOGIA_SOURCE) {
  const { row } = await saveTemplateDraft(db, { sourceYaml: source });
  return setTemplateStatus(db, row.slug, row.version, "published");
}

const ODONTOLOGIA = (() => {
  const template = validateTemplateSource(ODONTOLOGIA_SOURCE).template;
  if (!template) throw new Error("templates/odontologia must validate");
  return template;
})();

/** Appendix A's sample_config, as written (no defaults applied). */
export const ODONTOLOGIA_SAMPLE_CONFIG: Record<string, unknown> = ODONTOLOGIA.sample_config;

/** The version the file declares. Tests use this, so a template bump needs no test edits. */
export const ODONTOLOGIA_VERSION: string = ODONTOLOGIA.manifest.version;

/** The agent model the file declares (`agent.model`). */
export const ODONTOLOGIA_MODEL: string = ODONTOLOGIA.agent.model;

/** The odontologia source declaring another version (upload, upgrade and lock tests). */
export function odontologiaAt(version: string, source = ODONTOLOGIA_SOURCE): string {
  return source.replace(/^ {2}version: \S+$/m, `  version: ${version}`);
}

/** A version after the file's: its next minor or its next major. */
export function laterVersion(kind: "minor" | "major"): string {
  const current = parseSemver(ODONTOLOGIA_VERSION);
  if (!current) throw new Error(`odontologia has a bad version: ${ODONTOLOGIA_VERSION}`);
  return kind === "major"
    ? `${String(current.major + 1)}.0.0`
    : `${String(current.major)}.${String(current.minor + 1)}.0`;
}

/** A business on the file's odontologia version (publishing the template first if needed). */
export async function createTestBusiness(db: Executor, name = "Clínica Demo") {
  const existing = await getTemplateVersion(db, "odontologia", ODONTOLOGIA_VERSION);
  if (existing?.status !== "published") await publishOdontologia(db);
  return createBusiness(db, {
    name,
    templateSlug: "odontologia",
    templateVersion: ODONTOLOGIA_VERSION,
    config: ODONTOLOGIA_SAMPLE_CONFIG,
  });
}

/**
 * A finished live eval run that passes the publish gate, for the stored upload of
 * slug@version: what the worker would write after real evals (spec §10). Tests use it to
 * publish through the gate without calling Claude.
 */
export async function recordPassingEvalRun(db: Executor, slug: string, version: string) {
  const row = await getTemplateVersion(db, slug, version);
  if (!row) throw new Error(`${slug}@${version} is not uploaded`);
  const now = new Date();
  const run = await insertEvalRun(db, {
    templateSlug: slug,
    templateVersion: version,
    sourceSha256: sourceSha256(row.sourceYaml),
    mode: "live",
    runsPerScenario: 3,
    requestedBy: null,
    status: "running",
    now,
  });
  return finishEvalRun(db, run.id, {
    results: null,
    passRate: 1,
    criticalPass: true,
    gatePassed: true,
    costUsd: 0,
    now,
  });
}
