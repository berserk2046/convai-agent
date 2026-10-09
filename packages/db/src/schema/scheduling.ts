import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses.ts";
import { contacts, conversations } from "./messaging.ts";

const tz = (name: string) => timestamp(name, { withTimezone: true });

/** Weekly opening ranges, same shape as the platform:weekly_hours config type. */
export type WeeklySchedule = Partial<
  Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", { open: string; close: string }[]>
>;

/** Something bookable: a chair, a vet, a table. */
export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    /** Matches the template's booking.resource_kind. */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** Seats for party-size bookings (tables); null means any size. */
    capacity: integer("capacity"),
    /** Narrows the business hours for this resource; null means the business hours. */
    schedule: jsonb("schedule").$type<WeeklySchedule>(),
    active: boolean("active").notNull().default(true),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("resources_business_kind_idx").on(t.businessId, t.kind),
    check("resources_capacity_check", sql`${t.capacity} is null or ${t.capacity} > 0`),
  ],
);

/**
 * Blocked time: vacations, maintenance. Null resource = the whole business. Public holidays
 * are built in (ADR 0009), not closures.
 */
export const closures = pgTable(
  "closures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    resourceId: uuid("resource_id").references(() => resources.id),
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at").notNull(),
    reason: text("reason"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("closures_business_range_idx").on(t.businessId, t.startsAt),
    check("closures_range_check", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);

export const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Appointments and reservations. The no-overlap guarantee (principle 3) is a gist
 * exclusion constraint added in a custom migration: Drizzle can't express it.
 */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    /** NOT NULL on purpose: NULLs never conflict in an exclusion constraint. */
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id),
    serviceKey: text("service_key").notNull(),
    /** Snapshots: what was booked, even if the catalog changes later. */
    serviceName: text("service_name").notNull(),
    priceCop: integer("price_cop"),
    subjectName: text("subject_name").notNull(),
    partySize: integer("party_size"),
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at").notNull(),
    status: text("status", { enum: BOOKING_STATUSES }).notNull().default("pending"),
    source: text("source", { enum: ["agent", "staff", "external"] }).notNull(),
    externalRef: text("external_ref"),
    notes: text("notes"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
    rescheduledAt: tz("rescheduled_at"),
    cancelledAt: tz("cancelled_at"),
    completedAt: tz("completed_at"),
  },
  (t) => [
    index("bookings_business_starts_idx").on(t.businessId, t.startsAt),
    index("bookings_contact_starts_idx").on(t.contactId, t.startsAt),
    check("bookings_range_check", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "bookings_status_check",
      sql`${t.status} in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')`,
    ),
    check("bookings_source_check", sql`${t.source} in ('agent', 'staff', 'external')`),
    check("bookings_party_size_check", sql`${t.partySize} is null or ${t.partySize} > 0`),
  ],
);

/**
 * Decision A5: a booking change the agent read back to the customer and is waiting for a
 * "yes" on. book/reschedule/cancel only run with confirmed_by_customer=true when a
 * proposal from an earlier turn matches.
 */
export const bookingProposals = pgTable(
  "booking_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    action: text("action", { enum: ["book", "reschedule", "cancel"] }).notNull(),
    /** The exact tool input that will run once confirmed. */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    /** The agent turn (batch) that created it; confirmation must come in a later one. */
    turnId: text("turn_id").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    expiresAt: tz("expires_at").notNull(),
    consumedAt: tz("consumed_at"),
  },
  (t) => [
    index("booking_proposals_conversation_idx").on(t.conversationId, t.createdAt),
    check("booking_proposals_action_check", sql`${t.action} in ('book', 'reschedule', 'cancel')`),
  ],
);

/** A conversation handed to a person (principle 7). At most one open per conversation. */
export const handoffs = pgTable(
  "handoffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    reason: text("reason").notNull(),
    /** Short context for staff; purged with message retention (personal data). */
    summary: text("summary"),
    openedAt: tz("opened_at").notNull().defaultNow(),
    /** Decision A3: the emergency reply is sent at most once per open handoff. */
    emergencyRepliedAt: tz("emergency_replied_at"),
    resolvedAt: tz("resolved_at"),
    resolvedBy: uuid("resolved_by"),
  },
  (t) => [
    uniqueIndex("handoffs_one_open_per_conversation")
      .on(t.conversationId)
      .where(sql`${t.resolvedAt} is null`),
  ],
);

export const USAGE_KINDS = ["wa_service", "wa_utility", "wa_marketing", "wa_auth", "llm"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** Billable usage per business (spec §6): the basis of budgets and cost reports. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    kind: text("kind", { enum: USAGE_KINDS }).notNull(),
    /** Tokens for llm, messages for wa_*. */
    units: integer("units").notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    at: tz("at").notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_business_at_idx").on(t.businessId, t.at),
    check(
      "usage_events_kind_check",
      sql`${t.kind} in ('wa_service', 'wa_utility', 'wa_marketing', 'wa_auth', 'llm')`,
    ),
  ],
);

export type ResourceRow = typeof resources.$inferSelect;
export type ClosureRow = typeof closures.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;
export type BookingProposalRow = typeof bookingProposals.$inferSelect;
export type HandoffRow = typeof handoffs.$inferSelect;
