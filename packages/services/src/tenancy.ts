import {
  getBusiness,
  getTemplateVersion,
  preparedTemplateFor,
  recordAudit,
  withTenant,
  type BusinessRow,
  type MembershipRole,
  type TemplateRow,
  type Transaction,
} from "@platform/db";
import type { PreparedTemplate, Template } from "@platform/templates";
import { parse as parseYaml } from "yaml";
import { requireBusiness, type Actor } from "./actor.ts";
import type { ServiceDeps } from "./deps.ts";
import { NotFoundError } from "./errors.ts";

/**
 * Runs business work inside the session business's tenant transaction (principle 6):
 * every id the request mentions is looked up under row-level security, so another
 * business's ids simply aren't found.
 */
export async function inBusiness<T>(
  deps: ServiceDeps,
  actor: Actor,
  roles: readonly MembershipRole[] | undefined,
  work: (scope: Scope) => Promise<T>,
): Promise<T> {
  const { businessId } = requireBusiness(actor, roles);
  return withTenant(deps.db, businessId, async (tx) => {
    const business = await getBusiness(tx, businessId);
    if (!business) throw new NotFoundError("business");
    return work({
      tx,
      business,
      audit: (action, payload) =>
        recordAudit(tx, {
          actorUserId: actor.userId,
          businessId,
          action,
          payload: actor.business?.impersonating ? { ...payload, impersonating: true } : payload,
        }),
    });
  });
}

export interface Scope {
  tx: Transaction;
  business: BusinessRow;
  /** Writes an audit entry in the same transaction as the change (spec §13). */
  audit: (action: string, payload?: Record<string, unknown>) => Promise<void>;
}

/** The business's pinned template, compiled. */
export async function pinnedTemplate(scope: Scope): Promise<PreparedTemplate> {
  return preparedTemplateFor(await pinnedRow(scope));
}

export async function pinnedRow(scope: Scope): Promise<TemplateRow> {
  const row = await getTemplateVersion(
    scope.tx,
    scope.business.templateSlug,
    scope.business.templateVersion,
  );
  if (!row) throw new NotFoundError("pinned template");
  return row;
}

/** The template's names for its handoff reasons, for staff (`agent.tools.handoff.labels`). */
export function handoffLabels(template: Template): Record<string, string> {
  const labels = template.agent.tools.handoff?.labels;
  if (typeof labels !== "object" || labels === null) return {};
  return Object.fromEntries(
    Object.entries(labels).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

const authored = new Map<string, Record<string, unknown>>();

/**
 * The template as written in its YAML, for key order: the stored manifest is jsonb, which
 * sorts object keys. Cached per published version (drafts change).
 */
export function authoredTemplate(row: TemplateRow): Record<string, unknown> {
  const key = `${row.slug}@${row.version}`;
  const cached = row.status === "draft" ? undefined : authored.get(key);
  if (cached) return cached;
  const source: unknown = parseYaml(row.sourceYaml);
  const parsed =
    typeof source === "object" && source !== null ? (source as Record<string, unknown>) : {};
  if (row.status !== "draft") authored.set(key, parsed);
  return parsed;
}

export function authoredConfigSchema(row: TemplateRow): unknown {
  return authoredTemplate(row).config_schema;
}

/** The template's contact field keys in the order the author wrote them. */
export function authoredContactFields(row: TemplateRow): string[] {
  const fields = authoredTemplate(row).contact_fields;
  return typeof fields === "object" && fields !== null ? Object.keys(fields) : [];
}

/** JSON with object keys sorted, for comparing values that went through jsonb. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
