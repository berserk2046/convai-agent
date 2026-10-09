import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { SlotTakenError, pgErrorCode } from "../errors.ts";
import {
  bookings,
  closures,
  resources,
  type BookingRow,
  type ClosureRow,
  type ResourceRow,
  type WeeklySchedule,
} from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

const ACTIVE = ["pending", "confirmed"] as const;
const EXCLUSION_VIOLATION = "23P01";

// --- resources and closures -------------------------------------------------------------

export async function createResource(
  db: Executor,
  input: {
    businessId: string;
    kind: string;
    name: string;
    capacity?: number | null;
    schedule?: WeeklySchedule | null;
  },
): Promise<ResourceRow> {
  const [row] = await db
    .insert(resources)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      name: input.name,
      capacity: input.capacity ?? null,
      schedule: input.schedule ?? null,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function listActiveResources(
  db: Executor,
  businessId: string,
  kind: string,
): Promise<ResourceRow[]> {
  return db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.businessId, businessId),
        eq(resources.kind, kind),
        eq(resources.active, true),
      ),
    )
    .orderBy(asc(resources.name));
}

export async function getResource(db: Executor, resourceId: string): Promise<ResourceRow | null> {
  const [row] = await db.select().from(resources).where(eq(resources.id, resourceId));
  return row ?? null;
}

export async function createClosure(
  db: Executor,
  input: {
    businessId: string;
    resourceId?: string | null;
    startsAt: Date;
    endsAt: Date;
    reason?: string | null;
  },
): Promise<ClosureRow> {
  const [row] = await db
    .insert(closures)
    .values({
      businessId: input.businessId,
      resourceId: input.resourceId ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason ?? null,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/** Closures overlapping [from, to). */
export async function listClosures(
  db: Executor,
  businessId: string,
  from: Date,
  to: Date,
): Promise<ClosureRow[]> {
  return db
    .select()
    .from(closures)
    .where(
      and(
        eq(closures.businessId, businessId),
        lt(closures.startsAt, to),
        gt(closures.endsAt, from),
      ),
    );
}

// --- bookings ------------------------------------------------------------------------------

/** Active bookings of these resources overlapping [from, to). */
export async function listActiveBookings(
  db: Executor,
  businessId: string,
  resourceIds: readonly string[],
  from: Date,
  to: Date,
): Promise<BookingRow[]> {
  if (resourceIds.length === 0) return [];
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        inArray(bookings.resourceId, [...resourceIds]),
        inArray(bookings.status, [...ACTIVE]),
        lt(bookings.startsAt, to),
        gt(bookings.endsAt, from),
      ),
    );
}

export interface NewBooking {
  businessId: string;
  contactId: string;
  resourceId: string;
  serviceKey: string;
  serviceName: string;
  priceCop: number | null;
  subjectName: string;
  partySize: number | null;
  startsAt: Date;
  endsAt: Date;
  source: "agent" | "staff" | "external";
  notes: string | null;
}

/** Inserts a booking; throws SlotTakenError if the database rejects an overlap. */
export async function insertBooking(db: Executor, input: NewBooking): Promise<BookingRow> {
  try {
    const [row] = await db.insert(bookings).values(input).returning();
    if (!row) throw new Error("insert returned no row");
    return row;
  } catch (error) {
    if (pgErrorCode(error) === EXCLUSION_VIOLATION) throw new SlotTakenError();
    throw error;
  }
}

/** A booking, only if it belongs to this contact (the agent passes ids it was given). */
export async function getContactBooking(
  db: Executor,
  bookingId: string,
  contactId: string,
): Promise<BookingRow | null> {
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.contactId, contactId)));
  return row ?? null;
}

/** The contact's active bookings from `from` on (or all, newest first, with `includePast`). */
export async function listContactBookings(
  db: Executor,
  contactId: string,
  options: { from: Date; includePast?: boolean },
): Promise<BookingRow[]> {
  if (options.includePast) {
    return db
      .select()
      .from(bookings)
      .where(eq(bookings.contactId, contactId))
      .orderBy(desc(bookings.startsAt))
      .limit(20);
  }
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.contactId, contactId),
        inArray(bookings.status, [...ACTIVE]),
        gte(bookings.startsAt, options.from),
      ),
    )
    .orderBy(asc(bookings.startsAt));
}

/** Moves a booking in one statement; the exclusion constraint guards the new slot. */
export async function moveBooking(
  db: Executor,
  bookingId: string,
  to: { startsAt: Date; endsAt: Date; resourceId: string },
): Promise<BookingRow> {
  try {
    const [row] = await db
      .update(bookings)
      .set({ ...to, rescheduledAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(bookings.id, bookingId), inArray(bookings.status, [...ACTIVE])))
      .returning();
    if (!row) throw new Error("booking is not active");
    return row;
  } catch (error) {
    if (pgErrorCode(error) === EXCLUSION_VIOLATION) throw new SlotTakenError();
    throw error;
  }
}

export async function cancelBooking(db: Executor, bookingId: string): Promise<BookingRow | null> {
  const [row] = await db
    .update(bookings)
    .set({ status: "cancelled", cancelledAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(bookings.id, bookingId), inArray(bookings.status, [...ACTIVE])))
    .returning();
  return row ?? null;
}

/**
 * Completion job (spec §8): active bookings that ended more than `graceMinutes` ago become
 * completed. Staff-marked no-shows are untouched. Platform-level: runs across businesses.
 */
export async function completeDueBookings(
  db: Executor,
  now: Date,
  graceMinutes = 60,
): Promise<BookingRow[]> {
  const cutoff = new Date(now.getTime() - graceMinutes * 60_000);
  return db
    .update(bookings)
    .set({ status: "completed", completedAt: now, updatedAt: now })
    .where(and(inArray(bookings.status, [...ACTIVE]), lt(bookings.endsAt, cutoff)))
    .returning();
}

/** Bookings visible to staff for a day/week view (M5) or reports. */
export async function listBookingsInRange(
  db: Executor,
  businessId: string,
  from: Date,
  to: Date,
): Promise<BookingRow[]> {
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        lt(bookings.startsAt, to),
        gt(bookings.endsAt, from),
      ),
    )
    .orderBy(asc(bookings.startsAt));
}
