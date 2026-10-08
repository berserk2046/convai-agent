import { DEFAULT_TIMEZONE, formatPath, validateBusinessConfig } from "@platform/templates";
import { eq, sql } from "drizzle-orm";
import { IANAZone } from "luxon";
import { z } from "zod";
import { BusinessNotFoundError, InvalidInputError, TemplateNotPublishedError } from "../errors.ts";
import {
  businesses,
  type BusinessLimits,
  type BusinessRow,
  type TemplateRow,
} from "../schema/index.ts";
import type { Executor } from "../tenant.ts";
import { getTemplateVersion, preparedTemplateFor } from "./templates.ts";

const limitsSchema = z.strictObject({
  llm_usd_month: z.number().positive().optional(),
  marketing_msgs_month: z.number().int().min(0).optional(),
});

export interface CreateBusinessInput {
  name: string;
  templateSlug: string;
  templateVersion: string;
  timezone?: string;
  /** Optional at creation: a business can be created first and configured during setup. */
  config?: unknown;
  limits?: BusinessLimits;
}

/** Platform-owner action: creates a business pinned to a published template version. */
export async function createBusiness(
  db: Executor,
  input: CreateBusinessInput,
): Promise<BusinessRow> {
  const template = await getTemplateVersion(db, input.templateSlug, input.templateVersion);
  if (template?.status !== "published") {
    throw new TemplateNotPublishedError(input.templateSlug, input.templateVersion);
  }

  const name = input.name.trim();
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const issues = [
    ...(name === "" ? [{ path: "name", message: "must not be empty" }] : []),
    ...(IANAZone.isValidZone(timezone)
      ? []
      : [{ path: "timezone", message: `"${timezone}" is not an IANA timezone` }]),
  ];
  const limits = limitsSchema.safeParse(input.limits ?? {});
  if (!limits.success) {
    issues.push(
      ...limits.error.issues.map((i) => ({
        path: formatPath(["limits", ...i.path.map(String)]),
        message: i.message,
      })),
    );
  }
  if (issues.length > 0 || !limits.success) throw new InvalidInputError("business", issues);

  const config = input.config === undefined ? null : validatedConfig(template, input.config);
  const [row] = await db
    .insert(businesses)
    .values({
      name,
      templateSlug: template.slug,
      templateVersion: template.version,
      timezone,
      config,
      limits: limits.data,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function getBusiness(db: Executor, businessId: string): Promise<BusinessRow | null> {
  const [row] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  return row ?? null;
}

/**
 * Replaces a business's config after validating it against the pinned template (spec §6).
 * Stores the copy with schema defaults applied. Business admins call this inside
 * withTenant(), so row-level security also guards the write.
 */
export async function updateBusinessConfig(
  db: Executor,
  businessId: string,
  config: unknown,
): Promise<BusinessRow> {
  const business = await getBusiness(db, businessId);
  if (!business) throw new BusinessNotFoundError();
  const template = await getTemplateVersion(db, business.templateSlug, business.templateVersion);
  if (!template)
    throw new Error(
      `pinned template ${business.templateSlug}@${business.templateVersion} is missing`,
    );

  const [row] = await db
    .update(businesses)
    .set({ config: validatedConfig(template, config), updatedAt: sql`now()` })
    .where(eq(businesses.id, businessId))
    .returning();
  if (!row) throw new BusinessNotFoundError();
  return row;
}

function validatedConfig(template: TemplateRow, config: unknown): Record<string, unknown> {
  const result = validateBusinessConfig(preparedTemplateFor(template), config);
  if (!result.ok) {
    throw new InvalidInputError(
      "config",
      result.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
    );
  }
  return result.value;
}
