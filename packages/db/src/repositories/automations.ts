import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  automationRuns,
  automations,
  bookings,
  businesses,
  channels,
  contacts,
  conversations,
  messages,
  staffNotifications,
  waMessageTemplates,
  type AutomationRow,
  type AutomationRunRow,
  type BusinessRow,
  type MessageRow,
  type RunStatus,
  type StaffNotificationRow,
  type WaMessageTemplateRow,
} from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

const ACTIVE_BOOKING = ["pending", "confirmed"] as const;

// --- automations (per-business rule settings) ----------------------------------------------

/** Adds the template's rules a business doesn't have yet; existing settings are kept. */
export async function seedAutomations(
  db: Executor,
  businessId: string,
  rules: readonly { key: string; default_enabled: boolean }[],
): Promise<void> {
  if (rules.length === 0) return;
  await db
    .insert(automations)
    .values(rules.map((r) => ({ businessId, ruleKey: r.key, enabled: r.default_enabled })))
    .onConflictDoNothing({ target: [automations.businessId, automations.ruleKey] });
}

export async function listAutomations(db: Executor, businessId: string): Promise<AutomationRow[]> {
  return db
    .select()
    .from(automations)
    .where(eq(automations.businessId, businessId))
    .orderBy(asc(automations.ruleKey));
}

export async function getAutomation(db: Executor, id: string): Promise<AutomationRow | null> {
  const [row] = await db.select().from(automations).where(eq(automations.id, id));
  return row ?? null;
}

/** Writes a rule's settings; the caller validates overrides against the template. */
export async function setAutomationSettings(
  db: Executor,
  businessId: string,
  ruleKey: string,
  settings: { enabled?: boolean; overrides?: Record<string, string> },
): Promise<AutomationRow | null> {
  const [row] = await db
    .update(automations)
    .set({ ...settings, updatedAt: sql`now()` })
    .where(and(eq(automations.businessId, businessId), eq(automations.ruleKey, ruleKey)))
    .returning();
  return row ?? null;
}

// --- runs (principle 8) ----------------------------------------------------------------------

export interface NewRun {
  businessId: string;
  automationId: string;
  subjectType: AutomationRunRow["subjectType"];
  subjectId: string;
  occurrenceKey: string;
  dueAt: Date;
}

/** Inserts runs that don't exist yet; returns only the new ones (those get enqueued). */
export async function insertRuns(
  db: Executor,
  runs: readonly NewRun[],
): Promise<AutomationRunRow[]> {
  if (runs.length === 0) return [];
  return db
    .insert(automationRuns)
    .values([...runs])
    .onConflictDoNothing({
      target: [
        automationRuns.automationId,
        automationRuns.subjectType,
        automationRuns.subjectId,
        automationRuns.occurrenceKey,
      ],
    })
    .returning();
}

export async function getRun(db: Executor, runId: string): Promise<AutomationRunRow | null> {
  const [row] = await db.select().from(automationRuns).where(eq(automationRuns.id, runId));
  return row ?? null;
}

/**
 * Ends a scheduled run. False when it had already ended: a second worker on the same run
 * then does nothing.
 */
export async function finishRun(
  db: Executor,
  runId: string,
  outcome: {
    status: Exclude<RunStatus, "scheduled">;
    reason?: string | null;
    error?: Record<string, unknown> | null;
    sentMessageId?: string | null;
  },
): Promise<boolean> {
  const rows = await db
    .update(automationRuns)
    .set({
      status: outcome.status,
      reason: outcome.reason ?? null,
      error: outcome.error ?? null,
      sentMessageId: outcome.sentMessageId ?? null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, "scheduled")))
    .returning({ id: automationRuns.id });
  return rows.length === 1;
}

/** Quiet hours: the run stays scheduled with a later due time. */
export async function postponeRun(db: Executor, runId: string, dueAt: Date): Promise<void> {
  await db
    .update(automationRuns)
    .set({ dueAt, reason: "quiet_hours", updatedAt: sql`now()` })
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, "scheduled")));
}

/**
 * Scheduled runs already due (platform-level). The sweeper re-enqueues them, so a run whose
 * job was lost (crash, Redis flush) still goes out.
 */
export async function listDueRuns(
  db: Executor,
  now: Date,
  limit = 500,
): Promise<Pick<AutomationRunRow, "id" | "businessId" | "dueAt">[]> {
  return db
    .select({
      id: automationRuns.id,
      businessId: automationRuns.businessId,
      dueAt: automationRuns.dueAt,
    })
    .from(automationRuns)
    .where(and(eq(automationRuns.status, "scheduled"), lte(automationRuns.dueAt, now)))
    .orderBy(asc(automationRuns.dueAt))
    .limit(limit);
}

/** Whether a rule has a sent run for this subject (optionally for one occurrence). */
export async function hasSentRun(
  db: Executor,
  filter: {
    automationId: string;
    subjectType: AutomationRunRow["subjectType"];
    subjectId: string;
    occurrenceKey?: string;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationId, filter.automationId),
        eq(automationRuns.subjectType, filter.subjectType),
        eq(automationRuns.subjectId, filter.subjectId),
        eq(automationRuns.status, "sent"),
        filter.occurrenceKey === undefined
          ? undefined
          : eq(automationRuns.occurrenceKey, filter.occurrenceKey),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Runs per rule and status since `from` (the /automations screen). */
export async function countRunsSince(
  db: Executor,
  businessId: string,
  from: Date,
): Promise<{ automationId: string; status: RunStatus; count: number }[]> {
  return db
    .select({
      automationId: automationRuns.automationId,
      status: automationRuns.status,
      count: sql<number>`count(*)::int`,
    })
    .from(automationRuns)
    .where(and(eq(automationRuns.businessId, businessId), gt(automationRuns.createdAt, from)))
    .groupBy(automationRuns.automationId, automationRuns.status);
}

export async function listRunsForSubject(
  db: Executor,
  subjectId: string,
): Promise<AutomationRunRow[]> {
  return db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.subjectId, subjectId))
    .orderBy(asc(automationRuns.createdAt));
}

// --- due subjects (sweeper) ------------------------------------------------------------------
// Each returns the subjects whose fire time falls in (from, to]. All tenant-scoped.

const minutes = (n: number) => sql`make_interval(mins => ${n})`;

/** booking.starts_in: active bookings whose start + offset is due (offset is negative). */
export async function dueBookingStarts(
  db: Executor,
  businessId: string,
  offsetMin: number,
  from: Date,
  to: Date,
): Promise<{ id: string; startsAt: Date; fireAt: Date }[]> {
  const fireAt = sql<Date>`${bookings.startsAt} + ${minutes(offsetMin)}`;
  const rows = await db
    .select({ id: bookings.id, startsAt: bookings.startsAt, fireAt: fireAt.mapWith(toDate) })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        inArray(bookings.status, [...ACTIVE_BOOKING]),
        // Index-friendly form of: from < starts_at + offset <= to.
        gt(bookings.startsAt, sql`${from.toISOString()}::timestamptz - ${minutes(offsetMin)}`),
        lte(bookings.startsAt, sql`${to.toISOString()}::timestamptz - ${minutes(offsetMin)}`),
        // Spec review B29: a reminder time before the booking existed (or moved) never fires.
        sql`${fireAt} >= coalesce(${bookings.rescheduledAt}, ${bookings.createdAt})`,
      ),
    );
  return rows;
}

/** booking.completed: completed bookings whose completion + offset is due. */
export async function dueBookingCompletions(
  db: Executor,
  businessId: string,
  offsetMin: number,
  from: Date,
  to: Date,
): Promise<{ id: string; fireAt: Date }[]> {
  const fireAt = sql<Date>`${bookings.completedAt} + ${minutes(offsetMin)}`;
  return db
    .select({ id: bookings.id, fireAt: fireAt.mapWith(toDate) })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.status, "completed"),
        sql`${fireAt} > ${from.toISOString()}::timestamptz`,
        sql`${fireAt} <= ${to.toISOString()}::timestamptz`,
      ),
    );
}

/**
 * booking.created / rescheduled / cancelled, from the booking's own timestamps. Events
 * insert these runs right away; this catches any an event failed to insert.
 */
export async function dueBookingChanges(
  db: Executor,
  businessId: string,
  change: "created" | "rescheduled" | "cancelled",
  from: Date,
  to: Date,
): Promise<{ id: string; at: Date }[]> {
  const column =
    change === "created"
      ? bookings.createdAt
      : change === "rescheduled"
        ? bookings.rescheduledAt
        : bookings.cancelledAt;
  const rows = await db
    .select({ id: bookings.id, at: column })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        gt(column, from),
        lte(column, to),
        change === "cancelled" ? eq(bookings.status, "cancelled") : undefined,
      ),
    );
  return rows.flatMap((r) => (r.at ? [{ id: r.id, at: r.at }] : []));
}

/**
 * contact.date_field: contacts whose date field + offset, at a local time, is due. Dates are
 * validated on write, but a malformed one is skipped rather than failing the sweep.
 */
export async function dueContactDates(
  db: Executor,
  input: {
    businessId: string;
    field: string;
    offsetMin: number;
    atLocalTime: string;
    timezone: string;
    from: Date;
    to: Date;
  },
): Promise<{ id: string; date: string; fireAt: Date }[]> {
  const value = sql<string>`${contacts.fields} ->> ${input.field}`;
  const date = sql`case when pg_input_is_valid(${value}, 'date') then (${value})::date end`;
  // date + local time + offset, read as wall-clock time in the business timezone.
  const fireAt = sql<Date>`((${date} + ${input.atLocalTime}::time) + ${minutes(input.offsetMin)}) at time zone ${input.timezone}`;
  const rows = await db
    .select({ id: contacts.id, date: value, fireAt: fireAt.mapWith(toDate) })
    .from(contacts)
    .where(
      and(
        eq(contacts.businessId, input.businessId),
        sql`${fireAt} > ${input.from.toISOString()}::timestamptz`,
        sql`${fireAt} <= ${input.to.toISOString()}::timestamptz`,
      ),
    );
  return rows;
}

/** conversation.inactive: conversations whose last inbound message + duration is due. */
export async function dueInactiveConversations(
  db: Executor,
  businessId: string,
  durationMin: number,
  from: Date,
  to: Date,
): Promise<{ id: string; lastInboundAt: Date }[]> {
  const fireAt = sql`${conversations.lastInboundAt} + ${minutes(durationMin)}`;
  const rows = await db
    .select({ id: conversations.id, lastInboundAt: conversations.lastInboundAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        sql`${fireAt} > ${from.toISOString()}::timestamptz`,
        sql`${fireAt} <= ${to.toISOString()}::timestamptz`,
      ),
    );
  return rows.flatMap((r) =>
    r.lastInboundAt ? [{ id: r.id, lastInboundAt: r.lastInboundAt }] : [],
  );
}

/** Whether the contact has an active booking starting after `now` (no_future_booking). */
export async function hasFutureBooking(
  db: Executor,
  contactId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.contactId, contactId),
        inArray(bookings.status, [...ACTIVE_BOOKING]),
        gt(bookings.startsAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function getBooking(db: Executor, bookingId: string) {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  return row ?? null;
}

/** Confirms a pending booking (a "Confirmo" tap); false if it isn't pending anymore. */
export async function confirmBooking(db: Executor, bookingId: string): Promise<boolean> {
  const rows = await db
    .update(bookings)
    .set({ status: "confirmed", confirmedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(bookings.id, bookingId), eq(bookings.status, "pending")))
    .returning({ id: bookings.id });
  return rows.length === 1;
}

// --- businesses (platform-level, for the sweeper and webhooks) -------------------------------

export async function listActiveBusinesses(db: Executor): Promise<BusinessRow[]> {
  return db.select().from(businesses).where(eq(businesses.status, "active"));
}

/** Businesses with an active channel on this WhatsApp Business Account (template webhooks). */
export async function findBusinessIdsByWaba(db: Executor, wabaId: string): Promise<string[]> {
  const rows = await db
    .select({ businessId: channels.businessId })
    .from(channels)
    .where(and(eq(channels.wabaId, wabaId), eq(channels.status, "active")));
  return rows.map((r) => r.businessId);
}

// --- Meta message templates --------------------------------------------------------------------

export interface DesiredWaTemplate {
  businessId: string;
  templateKey: string;
  metaName: string;
  language: string;
  categoryRequested: string;
  components: Record<string, unknown>[];
}

/** Records what should be at Meta; existing Meta state (id, status) is kept. */
export async function upsertWaTemplate(
  db: Executor,
  desired: DesiredWaTemplate,
): Promise<WaMessageTemplateRow> {
  const [row] = await db
    .insert(waMessageTemplates)
    .values(desired)
    .onConflictDoUpdate({
      target: [
        waMessageTemplates.businessId,
        waMessageTemplates.metaName,
        waMessageTemplates.language,
      ],
      set: {
        templateKey: desired.templateKey,
        categoryRequested: desired.categoryRequested,
        components: desired.components,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error("upsert returned no row");
  return row;
}

export async function listWaTemplates(
  db: Executor,
  businessId: string,
): Promise<WaMessageTemplateRow[]> {
  return db
    .select()
    .from(waMessageTemplates)
    .where(eq(waMessageTemplates.businessId, businessId))
    .orderBy(asc(waMessageTemplates.metaName));
}

export async function getWaTemplate(
  db: Executor,
  businessId: string,
  metaName: string,
  language: string,
): Promise<WaMessageTemplateRow | null> {
  const [row] = await db
    .select()
    .from(waMessageTemplates)
    .where(
      and(
        eq(waMessageTemplates.businessId, businessId),
        eq(waMessageTemplates.metaName, metaName),
        eq(waMessageTemplates.language, language),
      ),
    );
  return row ?? null;
}

/** After a create or edit call: Meta's id, status and category, and what was sent. */
export async function recordWaTemplateSubmission(
  db: Executor,
  id: string,
  result: {
    metaTemplateId: string;
    status: string | null;
    category: string | null;
    submittedComponents: Record<string, unknown>[];
    at: Date;
  },
): Promise<void> {
  await db
    .update(waMessageTemplates)
    .set({
      metaTemplateId: result.metaTemplateId,
      submittedComponents: result.submittedComponents,
      submittedAt: result.at,
      ...(result.status ? { metaStatus: result.status, statusAt: result.at } : {}),
      ...(result.category ? { categoryMeta: result.category } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(waMessageTemplates.id, id));
}

/**
 * A status or category change reported by Meta (webhook or sync). Matched by name and
 * language, which are unique per WhatsApp Business Account: webhooks send the template id
 * as a JSON number, which can lose precision. Fills in Meta's id when we didn't have it.
 */
export async function applyWaTemplateUpdate(
  db: Executor,
  businessId: string,
  match: {
    name: string;
    language: string;
    /** Meta's id; null when it may be imprecise. */
    metaTemplateId: string | null;
    /** Overwrite a stored id (Meta's list is authoritative); else only fill a missing one. */
    replaceId?: boolean;
  },
  update: {
    status?: string;
    reason?: string | null;
    category?: string;
    info?: Record<string, unknown>;
    at: Date;
  },
): Promise<WaMessageTemplateRow[]> {
  return db
    .update(waMessageTemplates)
    .set({
      ...(match.metaTemplateId === null
        ? {}
        : {
            metaTemplateId: match.replaceId
              ? match.metaTemplateId
              : sql`coalesce(${waMessageTemplates.metaTemplateId}, ${match.metaTemplateId})`,
          }),
      ...(update.status === undefined
        ? {}
        : {
            metaStatus: update.status,
            statusAt: update.at,
            rejectedReason: update.status === "REJECTED" ? (update.reason ?? null) : null,
          }),
      ...(update.category === undefined ? {} : { categoryMeta: update.category }),
      ...(update.info === undefined
        ? {}
        : {
            statusInfo: sql`${waMessageTemplates.statusInfo} || ${JSON.stringify(update.info)}::jsonb`,
          }),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(waMessageTemplates.businessId, businessId),
        eq(waMessageTemplates.metaName, match.name),
        sql`lower(${waMessageTemplates.language}) = lower(${match.language})`,
      ),
    )
    .returning();
}

// --- staff notifications (decision A15) ------------------------------------------------------

/** Adds an inbox item; with a dedupe key, only the first call creates it. */
export async function notifyStaff(
  db: Executor,
  input: {
    businessId: string;
    kind: "automation" | "button" | "usage";
    text: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string | null;
  },
): Promise<StaffNotificationRow | null> {
  const [row] = await db
    .insert(staffNotifications)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      text: input.text,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: [staffNotifications.businessId, staffNotifications.dedupeKey] })
    .returning();
  return row ?? null;
}

export async function listStaffNotifications(
  db: Executor,
  businessId: string,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<StaffNotificationRow[]> {
  return db
    .select()
    .from(staffNotifications)
    .where(
      and(
        eq(staffNotifications.businessId, businessId),
        options.unreadOnly ? isNull(staffNotifications.readAt) : undefined,
      ),
    )
    .orderBy(desc(staffNotifications.createdAt))
    .limit(options.limit ?? 100);
}

// --- marketing caps (principle 10) -------------------------------------------------------------

/**
 * Template messages of a category sent (or being sent) since `from`. The category is the
 * one recorded at send time, which is Meta's when it reported one (B31).
 */
export async function countTemplateMessagesSince(
  db: Executor,
  businessId: string,
  category: string,
  from: Date,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.businessId, businessId),
        eq(messages.type, "template"),
        eq(messages.direction, "outbound"),
        ne(messages.status, "failed"),
        sql`${messages.payload} ->> 'category' = ${category}`,
        sql`${messages.createdAt} >= ${from.toISOString()}::timestamptz`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * The latest message sent to a conversation since `from` (typed button replies, A11: they
 * count only while the template is the last thing we said).
 */
export async function lastOutboundMessage(
  db: Executor,
  conversationId: string,
  from: Date,
): Promise<MessageRow | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, "outbound"),
        ne(messages.status, "failed"),
        sql`${messages.createdAt} >= ${from.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row ?? null;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
