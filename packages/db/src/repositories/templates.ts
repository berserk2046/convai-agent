import {
  compareSemver,
  prepareTemplate,
  validateTemplateSource,
  type Issue,
  type PreparedTemplate,
} from "@platform/templates";
import { and, desc, eq, sql } from "drizzle-orm";
import { TemplateInvalidError, TemplateVersionLockedError } from "../errors.ts";
import { verticalTemplates, type TemplateRow, type TemplateStatus } from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

/**
 * Validates and stores a template upload as a draft (spec §10: validate every upload).
 * Re-uploading a draft version replaces it; published and deprecated versions are locked.
 * Only the platform owner may call this (principle 2).
 */
export async function saveTemplateDraft(
  db: Executor,
  input: { sourceYaml: string; createdBy?: string | null },
): Promise<{ row: TemplateRow; warnings: Issue[] }> {
  const first = validateTemplateSource(input.sourceYaml);
  if (!first.template) throw new TemplateInvalidError(first.issues);
  const { slug, version } = first.template.manifest;

  const existing = await listTemplateVersions(db, slug);
  const locked = existing.find((t) => t.version === version && t.status !== "draft");
  if (locked) throw new TemplateVersionLockedError(slug, version, locked.status);

  // Upgrade rules compare against the highest published version below this one.
  const previous = existing
    .filter((t) => t.status === "published" && compareSemver(t.version, version) < 0)
    .sort((a, b) => compareSemver(b.version, a.version))[0];
  const report = validateTemplateSource(input.sourceYaml, {
    publishedVersions: existing.filter((t) => t.status !== "draft").map((t) => t.version),
    ...(previous ? { previous: previous.manifest } : {}),
  });
  if (!report.ok || !report.template) throw new TemplateInvalidError(report.issues);

  const values = {
    slug,
    version,
    manifest: report.template,
    sourceYaml: input.sourceYaml,
    createdBy: input.createdBy ?? null,
  };
  const [row] = await db
    .insert(verticalTemplates)
    .values(values)
    .onConflictDoUpdate({
      target: [verticalTemplates.slug, verticalTemplates.version],
      set: { ...values, createdAt: sql`now()` },
      // A concurrent publish wins: never overwrite a locked version.
      setWhere: sql`${verticalTemplates.status} = 'draft'`,
    })
    .returning();
  if (!row) throw new TemplateVersionLockedError(slug, version, "published");
  return { row, warnings: report.issues.filter((i) => i.severity === "warning") };
}

export async function getTemplateVersion(
  db: Executor,
  slug: string,
  version: string,
): Promise<TemplateRow | null> {
  const [row] = await db
    .select()
    .from(verticalTemplates)
    .where(and(eq(verticalTemplates.slug, slug), eq(verticalTemplates.version, version)));
  return row ?? null;
}

/** Newest first. */
export async function listTemplateVersions(db: Executor, slug: string): Promise<TemplateRow[]> {
  return db
    .select()
    .from(verticalTemplates)
    .where(eq(verticalTemplates.slug, slug))
    .orderBy(desc(verticalTemplates.createdAt));
}

/**
 * Moves a version along draft → published → deprecated. The publish gate (evals, spec §10)
 * is enforced by the publish command that calls this (M6).
 */
export async function setTemplateStatus(
  db: Executor,
  slug: string,
  version: string,
  status: Exclude<TemplateStatus, "draft">,
): Promise<TemplateRow> {
  const from = status === "published" ? "draft" : "published";
  const [row] = await db
    .update(verticalTemplates)
    .set({ status, ...(status === "published" ? { publishedAt: sql`now()` } : {}) })
    .where(
      and(
        eq(verticalTemplates.slug, slug),
        eq(verticalTemplates.version, version),
        eq(verticalTemplates.status, from),
      ),
    )
    .returning();
  if (!row) throw new Error(`${slug}@${version} is not ${from}, so it can't become ${status}`);
  return row;
}

/** Compiled templates of immutable versions, by row id; the oldest is evicted first. */
const prepared = new Map<string, PreparedTemplate>();
const PREPARED_CACHE_SIZE = 64;

/**
 * Compiled schemas for a stored template; cached for immutable (non-draft) versions. Keyed
 * by row id, not slug@version: eval and playground scratch databases install their own
 * copy of a version, possibly from a different upload of the same draft (ADR 0015).
 */
export function preparedTemplateFor(
  row: Pick<TemplateRow, "id" | "status" | "manifest">,
): PreparedTemplate {
  if (row.status === "draft") return prepareTemplate(row.manifest);
  let entry = prepared.get(row.id);
  if (!entry) {
    entry = prepareTemplate(row.manifest);
    prepared.set(row.id, entry);
    if (prepared.size > PREPARED_CACHE_SIZE) {
      const oldest = prepared.keys().next().value;
      if (oldest !== undefined) prepared.delete(oldest);
    }
  }
  return entry;
}
