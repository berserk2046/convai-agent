import type { Template } from "@platform/templates";
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const TEMPLATE_STATUSES = ["draft", "published", "deprecated"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** Uploaded vertical templates (spec §6). Platform-level: no business_id, no RLS. */
export const verticalTemplates = pgTable(
  "vertical_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    version: text("version").notNull(),
    status: text("status", { enum: TEMPLATE_STATUSES }).notNull().default("draft"),
    /** The full parsed template (meta-schema output). */
    manifest: jsonb("manifest").$type<Template>().notNull(),
    sourceYaml: text("source_yaml").notNull(),
    evalReport: jsonb("eval_report"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    unique("vertical_templates_slug_version_key").on(t.slug, t.version),
    check(
      "vertical_templates_status_check",
      sql`${t.status} in ('draft', 'published', 'deprecated')`,
    ),
  ],
);

export type TemplateRow = typeof verticalTemplates.$inferSelect;
