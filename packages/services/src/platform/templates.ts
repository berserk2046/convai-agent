import {
  TemplateInvalidError,
  TemplateVersionLockedError,
  businesses,
  verticalTemplates,
  getTemplateVersion,
  listTemplateVersions,
  recordAudit,
  saveTemplateDraft,
  setTemplateStatus,
  type TemplateRow,
} from "@platform/db";
import { compareSemver, validateTemplateSource, type Issue } from "@platform/templates";
import { and, count, eq } from "drizzle-orm";
import { stringify } from "yaml";
import { requireOwner, type Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { diffLines, hasChanges, type DiffLine } from "../diff.ts";
import { ActionRefusedError, NotFoundError } from "../errors.ts";
import { authoredTemplate } from "../tenancy.ts";

/**
 * /templates (spec §12, platform owner): upload YAML (validation errors with paths and
 * lines), version detail with a diff against the previous version, publish and deprecate.
 * The publish gate on evals arrives with M6.
 */

export interface TemplateSummary {
  slug: string;
  name: string;
  versions: { version: string; status: string; createdAt: Date; publishedAt: Date | null }[];
}

export async function listTemplates(deps: ServiceDeps, actor: Actor): Promise<TemplateSummary[]> {
  requireOwner(actor);
  const rows = await deps.db.select().from(verticalTemplates);
  const bySlug = new Map<string, TemplateRow[]>();
  for (const row of rows) bySlug.set(row.slug, [...(bySlug.get(row.slug) ?? []), row]);
  return [...bySlug.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, versions]) => {
      const sorted = versions.sort((a, b) => compareSemver(b.version, a.version));
      return {
        slug,
        name: sorted[0]?.manifest.manifest.name ?? slug,
        versions: sorted.map((v) => ({
          version: v.version,
          status: v.status,
          createdAt: v.createdAt,
          publishedAt: v.publishedAt,
        })),
      };
    });
}

export type UploadResult =
  { ok: true; slug: string; version: string; warnings: Issue[] } | { ok: false; issues: Issue[] };

/** Validates and stores a draft (re-uploading a draft version replaces it). */
export async function uploadTemplate(
  deps: ServiceDeps,
  actor: Actor,
  sourceYaml: string,
): Promise<UploadResult> {
  requireOwner(actor);
  try {
    const { row, warnings } = await saveTemplateDraft(deps.db, {
      sourceYaml,
      createdBy: actor.userId,
    });
    await recordAudit(deps.db, {
      actorUserId: actor.userId,
      businessId: null,
      action: "template.upload",
      payload: { slug: row.slug, version: row.version },
    });
    return { ok: true, slug: row.slug, version: row.version, warnings };
  } catch (error) {
    if (error instanceof TemplateInvalidError) return { ok: false, issues: [...error.issues] };
    if (error instanceof TemplateVersionLockedError) {
      return {
        ok: false,
        issues: [{ severity: "error", path: "manifest.version", message: error.message }],
      };
    }
    throw error;
  }
}

export interface TemplateDetail {
  slug: string;
  version: string;
  status: string;
  name: string;
  description: string;
  createdAt: Date;
  publishedAt: Date | null;
  warnings: Issue[];
  /** The version this one is compared with: the highest lower version. */
  previous: string | null;
  /** Changed sections only. */
  diff: { section: string; lines: DiffLine[] }[];
  sourceYaml: string;
  businessesPinned: number;
}

const SECTIONS = [
  "manifest",
  "config_schema",
  "contact_fields",
  "consent",
  "booking",
  "agent",
  "guardrails",
  "wa_templates",
  "automations",
  "evals",
] as const;

export async function templateDetail(
  deps: ServiceDeps,
  actor: Actor,
  slug: string,
  version: string,
): Promise<TemplateDetail> {
  requireOwner(actor);
  const row = await getTemplateVersion(deps.db, slug, version);
  if (!row) throw new NotFoundError("template");
  const previous = (await listTemplateVersions(deps.db, slug))
    .filter((t) => compareSemver(t.version, version) < 0)
    .sort((a, b) => compareSemver(b.version, a.version))[0];
  const [pinned] = await deps.db
    .select({ n: count() })
    .from(businesses)
    .where(and(eq(businesses.templateSlug, slug), eq(businesses.templateVersion, version)));
  const report = validateTemplateSource(row.sourceYaml);
  return {
    slug,
    version,
    status: row.status,
    name: row.manifest.manifest.name,
    description: row.manifest.manifest.description,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    warnings: report.issues.filter((i) => i.severity === "warning"),
    previous: previous?.version ?? null,
    diff: previous ? templateDiff(previous, row) : [],
    sourceYaml: row.sourceYaml,
    businessesPinned: pinned?.n ?? 0,
  };
}

/** The sections that changed between two versions, as the author wrote them. */
export function templateDiff(
  before: TemplateRow,
  after: TemplateRow,
): { section: string; lines: DiffLine[] }[] {
  const a = authoredTemplate(before);
  const b = authoredTemplate(after);
  return SECTIONS.flatMap((section) => {
    const lines = diffLines(yamlOf(a[section]), yamlOf(b[section]));
    return hasChanges(lines) ? [{ section, lines }] : [];
  });
}

export async function publishTemplate(
  deps: ServiceDeps,
  actor: Actor,
  slug: string,
  version: string,
): Promise<void> {
  requireOwner(actor);
  await changeStatus(deps, actor, slug, version, "published");
}

export async function deprecateTemplate(
  deps: ServiceDeps,
  actor: Actor,
  slug: string,
  version: string,
): Promise<void> {
  requireOwner(actor);
  await changeStatus(deps, actor, slug, version, "deprecated");
}

async function changeStatus(
  deps: ServiceDeps,
  actor: Actor,
  slug: string,
  version: string,
  status: "published" | "deprecated",
): Promise<void> {
  const row = await getTemplateVersion(deps.db, slug, version);
  if (!row) throw new NotFoundError("template");
  const from = status === "published" ? "draft" : "published";
  if (row.status !== from) {
    throw new ActionRefusedError(
      "wrong_status",
      `${slug}@${version} is ${row.status}, not ${from}`,
    );
  }
  await setTemplateStatus(deps.db, slug, version, status);
  await recordAudit(deps.db, {
    actorUserId: actor.userId,
    businessId: null,
    action: `template.${status === "published" ? "publish" : "deprecate"}`,
    payload: { slug, version },
  });
}

function yamlOf(value: unknown): string {
  return value === undefined ? "" : stringify(value, { lineWidth: 0 }).trimEnd();
}
