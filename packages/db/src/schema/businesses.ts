import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { verticalTemplates } from "./vertical-templates.ts";

export const BUSINESS_STATUSES = ["setup", "active", "paused"] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

/** Monthly caps (principle 10). Absent means the platform default applies. */
export interface BusinessLimits {
  llm_usd_month?: number;
  marketing_msgs_month?: number;
}

/** Platform-owner overrides of template agent settings (spec review B12). */
export interface AgentOverrides {
  model?: string;
}

/** A tenant. RLS: a tenant transaction only sees the row whose id it is scoped to. */
export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    templateSlug: text("template_slug").notNull(),
    templateVersion: text("template_version").notNull(),
    /**
     * Validated against the pinned template's config_schema on every write, stored with
     * schema defaults applied. Null while the business is still being set up.
     */
    config: jsonb("config").$type<Record<string, unknown>>(),
    timezone: text("timezone").notNull().default("America/Bogota"),
    status: text("status", { enum: BUSINESS_STATUSES }).notNull().default("setup"),
    limits: jsonb("limits").$type<BusinessLimits>().notNull().default({}),
    agentOverrides: jsonb("agent_overrides").$type<AgentOverrides>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "businesses_template_fk",
      columns: [t.templateSlug, t.templateVersion],
      foreignColumns: [verticalTemplates.slug, verticalTemplates.version],
    }),
    check("businesses_status_check", sql`${t.status} in ('setup', 'active', 'paused')`),
    check("businesses_configured_check", sql`${t.status} = 'setup' or ${t.config} is not null`),
  ],
);

export type BusinessRow = typeof businesses.$inferSelect;
