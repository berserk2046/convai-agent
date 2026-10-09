import { isHolidayKey } from "@platform/shared";
import {
  DEFAULT_TIMEZONE,
  formatPath,
  metaComponents,
  metaTemplateName,
  parseSemver,
  validateBusinessConfig,
  type Template,
} from "@platform/templates";
import { eq, sql } from "drizzle-orm";
import { IANAZone } from "luxon";
import { z } from "zod";
import { BusinessNotFoundError, InvalidInputError, TemplateNotPublishedError } from "../errors.ts";
import {
  businesses,
  type BusinessLimits,
  type BusinessRow,
  type HolidaySettings,
  type TemplateRow,
} from "../schema/index.ts";
import type { Executor } from "../tenant.ts";
import { seedAutomations, upsertWaTemplate } from "./automations.ts";
import { getTemplateVersion, preparedTemplateFor } from "./templates.ts";

const limitsSchema = z.strictObject({
  llm_usd_month: z.number().positive().optional(),
  marketing_msgs_month: z.number().int().min(0).optional(),
});

const holidaysSchema = z.strictObject({
  open_holidays: z
    .array(z.string().refine(isHolidayKey, "is not a Colombian public holiday"))
    .max(50)
    .optional(),
});

export interface CreateBusinessInput {
  name: string;
  templateSlug: string;
  templateVersion: string;
  timezone?: string;
  /** Optional at creation: a business can be created first and configured during setup. */
  config?: unknown;
  limits?: BusinessLimits;
  holidays?: HolidaySettings;
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
  if (!limits.success) issues.push(...fieldIssues("limits", limits.error));
  const holidays = holidaysSchema.safeParse(input.holidays ?? {});
  if (!holidays.success) issues.push(...fieldIssues("holidays", holidays.error));
  if (issues.length > 0 || !limits.success || !holidays.success) {
    throw new InvalidInputError("business", issues);
  }

  const config = input.config === undefined ? null : validatedConfig(template, input.config);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(businesses)
      .values({
        name,
        templateSlug: template.slug,
        templateVersion: template.version,
        timezone,
        config,
        limits: limits.data,
        holidays: normalizedHolidays(holidays.data),
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    // Spec §6: the template's automation rules, each with its default on/off.
    await seedAutomations(tx, row.id, template.manifest.automations);
    return row;
  });
}

/**
 * Setup → active (spec §12 activation checklist; §9: activation submits the Meta
 * templates). Records which Meta templates the business needs; the automations worker
 * submits them. Needs a config (also a DB constraint).
 */
export async function activateBusiness(db: Executor, businessId: string): Promise<BusinessRow> {
  const business = await getBusiness(db, businessId);
  if (!business) throw new BusinessNotFoundError();
  if (business.config === null) {
    throw new InvalidInputError("business", [
      { path: "config", message: "must be filled in before activation" },
    ]);
  }
  const template = await getTemplateVersion(db, business.templateSlug, business.templateVersion);
  if (!template)
    throw new Error(
      `pinned template ${business.templateSlug}@${business.templateVersion} is missing`,
    );
  await syncWaTemplates(db, business.id, template.manifest);
  await seedAutomations(db, business.id, template.manifest.automations);
  const [row] = await db
    .update(businesses)
    .set({ status: "active", updatedAt: sql`now()` })
    .where(eq(businesses.id, businessId))
    .returning();
  if (!row) throw new BusinessNotFoundError();
  return row;
}

/** One row per wa_templates entry, named `<key>_v<major>` (spec §9), with Meta's components. */
export async function syncWaTemplates(
  db: Executor,
  businessId: string,
  template: Template,
): Promise<void> {
  const major = parseSemver(template.manifest.version)?.major ?? 1;
  for (const wa of template.wa_templates) {
    await upsertWaTemplate(db, {
      businessId,
      templateKey: wa.key,
      metaName: metaTemplateName(wa.key, major),
      language: wa.language,
      categoryRequested: wa.category,
      components: metaComponents(wa),
    });
  }
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

/** Sets which public holidays the business opens on (spec review C2); the rest stay closed. */
export async function updateBusinessHolidays(
  db: Executor,
  businessId: string,
  holidays: HolidaySettings,
): Promise<BusinessRow> {
  const parsed = holidaysSchema.safeParse(holidays);
  if (!parsed.success) throw new InvalidInputError("holidays", fieldIssues("", parsed.error));
  const [row] = await db
    .update(businesses)
    .set({ holidays: normalizedHolidays(parsed.data), updatedAt: sql`now()` })
    .where(eq(businesses.id, businessId))
    .returning();
  if (!row) throw new BusinessNotFoundError();
  return row;
}

/** Switches one holiday on (the business opens every year) or off (closed, the default). */
export async function setHolidayOpen(
  db: Executor,
  businessId: string,
  holidayKey: string,
  open: boolean,
): Promise<BusinessRow> {
  const business = await getBusiness(db, businessId);
  if (!business) throw new BusinessNotFoundError();
  const current = new Set(business.holidays.open_holidays ?? []);
  if (open) current.add(holidayKey);
  else current.delete(holidayKey);
  return updateBusinessHolidays(db, businessId, { open_holidays: [...current] });
}

function normalizedHolidays(holidays: HolidaySettings): HolidaySettings {
  return holidays.open_holidays
    ? { open_holidays: [...new Set(holidays.open_holidays)].sort() }
    : {};
}

function fieldIssues(root: string, error: z.ZodError) {
  return error.issues.map((i) => ({
    path: formatPath([
      ...(root ? [root] : []),
      ...i.path.map((p) => (typeof p === "number" ? p : String(p))),
    ]),
    message: i.message,
  }));
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
