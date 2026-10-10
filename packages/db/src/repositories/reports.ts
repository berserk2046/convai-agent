import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  automationRuns,
  automations,
  bookings,
  businesses,
  handoffs,
  messages,
  usageEvents,
  type UsageKind,
} from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

/** Monthly figures (spec §12 /reports and /usage). Times are [from, to). */

export interface MonthlyFigures {
  /** Conversations where the customer wrote during the month. */
  conversations: number;
  /** …of which had no handoff opened during the month. */
  withoutHandoff: number;
  handoffsByReason: { reason: string; count: number }[];
  /** Bookings made during the month, by who made them. */
  bookingsBySource: { source: string; count: number }[];
  /** Appointments that fell in the month, by outcome. */
  appointments: { total: number; confirmed: number; noShows: number; cancelled: number };
  /** Automatic messages and actions carried out, per rule. */
  automationsSent: { ruleKey: string; count: number }[];
  costs: { kind: UsageKind; usd: number }[];
}

export async function monthlyFigures(
  db: Executor,
  businessId: string,
  from: Date,
  to: Date,
): Promise<MonthlyFigures> {
  const inMonth = (column: Parameters<typeof gte>[0]) => and(gte(column, from), lt(column, to));

  // Two plain queries rather than a correlated subquery: Drizzle leaves column names
  // unqualified in single-table selects, which would bind them to the inner table.
  const talked = await db
    .selectDistinct({ id: messages.conversationId })
    .from(messages)
    .where(
      and(
        eq(messages.businessId, businessId),
        eq(messages.direction, "inbound"),
        inMonth(messages.createdAt),
      ),
    );
  const handedOff = new Set(
    (
      await db
        .selectDistinct({ id: handoffs.conversationId })
        .from(handoffs)
        .where(and(eq(handoffs.businessId, businessId), inMonth(handoffs.openedAt)))
    ).map((r) => r.id),
  );

  const handoffsByReason = await db
    .select({ reason: handoffs.reason, count: sql<number>`count(*)::int` })
    .from(handoffs)
    .where(and(eq(handoffs.businessId, businessId), inMonth(handoffs.openedAt)))
    .groupBy(handoffs.reason)
    .orderBy(sql`count(*) desc`);

  const bookingsBySource = await db
    .select({ source: bookings.source, count: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), inMonth(bookings.createdAt)))
    .groupBy(bookings.source)
    .orderBy(bookings.source);

  const [appointments] = await db
    .select({
      total: sql<number>`count(*) filter (where ${bookings.status} <> 'cancelled')::int`,
      confirmed: sql<number>`count(*) filter (where ${bookings.confirmedAt} is not null and ${bookings.status} <> 'cancelled')::int`,
      noShows: sql<number>`count(*) filter (where ${bookings.status} = 'no_show')::int`,
      cancelled: sql<number>`count(*) filter (where ${bookings.status} = 'cancelled')::int`,
    })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), inMonth(bookings.startsAt)));

  const automationsSent = await db
    .select({ ruleKey: automations.ruleKey, count: sql<number>`count(*)::int` })
    .from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(
      and(
        eq(automationRuns.businessId, businessId),
        eq(automationRuns.status, "sent"),
        inMonth(automationRuns.finishedAt),
      ),
    )
    .groupBy(automations.ruleKey)
    .orderBy(automations.ruleKey);

  const costs = await usageCosts(db, businessId, from, to);

  return {
    conversations: talked.length,
    withoutHandoff: talked.filter((c) => !handedOff.has(c.id)).length,
    handoffsByReason,
    bookingsBySource,
    appointments: appointments ?? { total: 0, confirmed: 0, noShows: 0, cancelled: 0 },
    automationsSent,
    costs,
  };
}

/** Spend per usage kind (LLM, WhatsApp categories) in [from, to). */
export async function usageCosts(
  db: Executor,
  businessId: string,
  from: Date,
  to: Date,
): Promise<{ kind: UsageKind; usd: number }[]> {
  const rows = await db
    .select({ kind: usageEvents.kind, usd: sql<string>`sum(${usageEvents.costUsd})` })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.businessId, businessId),
        gte(usageEvents.at, from),
        lt(usageEvents.at, to),
      ),
    )
    .groupBy(usageEvents.kind)
    .orderBy(usageEvents.kind);
  return rows.map((r) => ({ kind: r.kind, usd: Number(r.usd) }));
}

/** Every business with its timezone and plan price (platform-level, for /usage). */
export async function listBusinessesForUsage(db: Executor) {
  return db
    .select({
      id: businesses.id,
      name: businesses.name,
      status: businesses.status,
      timezone: businesses.timezone,
      planPriceUsd: businesses.planPriceUsd,
      limits: businesses.limits,
    })
    .from(businesses)
    .orderBy(businesses.name);
}
