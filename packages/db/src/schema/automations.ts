import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.ts";
import { messages } from "./messaging.ts";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** A business's copy of each template automation rule (spec §6), seeded from the template. */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    /** The template's `automations[].key`. */
    ruleKey: text("rule_key").notNull(),
    enabled: boolean("enabled").notNull(),
    /** Values for the rule's `overridable` trigger params, e.g. { "trigger.offset": "-48h" }. */
    overrides: jsonb("overrides").$type<Record<string, string>>().notNull().default({}),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("automations_business_rule_key").on(t.businessId, t.ruleKey)],
);

export const RUN_STATUSES = ["scheduled", "sent", "skipped", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const SUBJECT_TYPES = ["booking", "contact", "conversation", "business"] as const;

/**
 * One firing of a rule for one subject (principle 8). The unique key makes every firing
 * happen at most once, however often the sweeper or an event inserts it. `sent` means the
 * action was carried out, whatever the action is.
 */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id),
    subjectType: text("subject_type", { enum: SUBJECT_TYPES }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** Which occurrence: the booking's start (ISO), "completed", the date field's value… */
    occurrenceKey: text("occurrence_key").notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("scheduled"),
    /** When it should run; moved forward when quiet hours postpone it. */
    dueAt: tz("due_at").notNull(),
    sentMessageId: uuid("sent_message_id").references(() => messages.id),
    /** Why it was skipped or failed, as a short code (e.g. "opted_out", "window_closed"). */
    reason: text("reason"),
    error: jsonb("error").$type<Record<string, unknown>>(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    finishedAt: tz("finished_at"),
  },
  (t) => [
    unique("automation_runs_occurrence_key").on(
      t.automationId,
      t.subjectType,
      t.subjectId,
      t.occurrenceKey,
    ),
    index("automation_runs_scheduled_due_idx")
      .on(t.dueAt)
      .where(sql`${t.status} = 'scheduled'`),
    index("automation_runs_subject_idx").on(t.subjectId),
    check(
      "automation_runs_status_check",
      sql`${t.status} in ('scheduled', 'sent', 'skipped', 'failed')`,
    ),
    check(
      "automation_runs_subject_type_check",
      sql`${t.subjectType} in ('booking', 'contact', 'conversation', 'business')`,
    ),
  ],
);

/**
 * A business's WhatsApp message templates at Meta (spec §9), one per template key and
 * language, named `<key>_v<major>`. `components` is what should be at Meta for the pinned
 * template version; `submitted_components` is what was last sent there.
 */
export const waMessageTemplates = pgTable(
  "wa_message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    templateKey: text("template_key").notNull(),
    metaName: text("meta_name").notNull(),
    language: text("language").notNull(),
    categoryRequested: text("category_requested").notNull(),
    /** The category Meta assigned; billing and caps use it (spec review B31). */
    categoryMeta: text("category_meta"),
    components: jsonb("components").$type<Record<string, unknown>[]>().notNull(),
    submittedComponents: jsonb("submitted_components").$type<Record<string, unknown>[]>(),
    metaTemplateId: text("meta_template_id"),
    /** Meta's status (APPROVED, PENDING, REJECTED, PAUSED…); null until submitted. */
    metaStatus: text("meta_status"),
    rejectedReason: text("rejected_reason"),
    /** Meta's extra details: rejection_info, disable_info, other_info, announced category changes. */
    statusInfo: jsonb("status_info").$type<Record<string, unknown>>().notNull().default({}),
    submittedAt: tz("submitted_at"),
    statusAt: tz("status_at"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("wa_message_templates_name_language").on(t.businessId, t.metaName, t.language),
    index("wa_message_templates_meta_id_idx").on(t.metaTemplateId),
  ],
);

/**
 * Items for the staff inbox and the admin badge (decision A15): `notify_staff` actions,
 * button taps during a handoff (A12), usage warnings (C3). The text can name customers,
 * so retention purges it like message text.
 */
export const staffNotifications = pgTable(
  "staff_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    /** "automation", "button" or "usage". */
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    /** Links for the admin: conversation_id, booking_id, run_id, rule_key… */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Same key, one notification: retries and repeated checks never duplicate it. */
    dedupeKey: text("dedupe_key"),
    createdAt: tz("created_at").notNull().defaultNow(),
    readAt: tz("read_at"),
  },
  (t) => [
    unique("staff_notifications_dedupe_key").on(t.businessId, t.dedupeKey),
    index("staff_notifications_business_created_idx").on(t.businessId, t.createdAt),
  ],
);

export type AutomationRow = typeof automations.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type WaMessageTemplateRow = typeof waMessageTemplates.$inferSelect;
export type StaffNotificationRow = typeof staffNotifications.$inferSelect;
