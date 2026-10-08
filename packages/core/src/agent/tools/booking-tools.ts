import {
  SlotTakenError,
  cancelBooking,
  consumeProposal,
  createProposal,
  getContactBooking,
  insertBooking,
  listContactBookings,
  listOpenProposals,
  moveBooking,
  setContactNameIfMissing,
  withTenant,
  type BookingProposalRow,
  type BookingRow,
} from "@platform/db";
import { chooseSlots, type Candidate } from "@platform/scheduling";
import { DateTime } from "luxon";
import { z } from "zod";
import { normalize } from "../guardrails.ts";
import { catalogAt, findItem, isBookable, slotView, type CatalogItem } from "./catalog.ts";
import {
  durationOf,
  effectiveRules,
  localDate,
  searchSlots,
  type EffectiveRules,
} from "./slots.ts";
import { toolError, type AgentTool, type ToolContext, type ToolOutcome } from "./types.ts";

/**
 * Booking tools with the server-enforced two-step confirmation (decision A5): a call
 * without a confirmation returns a proposal to read back; the change only happens when a
 * later call confirms a proposal made in an *earlier* customer message. The model can't
 * book in the same turn the customer asked.
 */

const PROPOSAL_TTL_MS = 2 * 60 * 60 * 1000;

const startsAt = z.iso
  .datetime({ offset: true })
  .describe(
    'Start time with offset, exactly as returned by check_availability, e.g. "2026-10-08T15:00:00-05:00"',
  );
const confirmed = z
  .boolean()
  .describe("true only after the customer explicitly said yes to the proposal you read back");
const proposalId = z
  .uuid()
  .optional()
  .describe("The proposal_id returned by the previous call, when confirming");

const CONFIRM_STEP =
  "Read this summary back to the customer and ask for an explicit yes. Only after they confirm in a new message, call the tool again with confirmed_by_customer=true and this proposal_id.";

// --- book -----------------------------------------------------------------------------------------

export const book: AgentTool = {
  name: "book",
  description:
    "Book an appointment. First call it with confirmed_by_customer=false: it checks the time and returns a proposal " +
    "(service, date label, price) to read back. After the customer explicitly confirms, call it again with " +
    "confirmed_by_customer=true and the proposal_id. `for_self` is true when the person writing is the one who will attend.",
  input: () =>
    z.strictObject({
      service_key: z.string(),
      starts_at: startsAt,
      subject_name: z.string().min(2).max(80).describe("Full name of the person who will attend"),
      for_self: z.boolean().describe("Whether the person writing is the one attending"),
      party_size: z.number().int().min(1).max(50).optional(),
      notes: z
        .string()
        .max(300)
        .optional()
        .describe("Anything staff should know, e.g. the guardian's name for a minor"),
      confirmed_by_customer: confirmed,
      proposal_id: proposalId,
    }),
  async run(ctx, input, params) {
    const rules = effectiveRules(ctx, params);
    const item = findItem(catalogAt(ctx.config, rules.catalogPath), String(input.service_key));
    if (!item) return toolError("unknown_service", "No service with that key.");
    if (!isBookable(item))
      return toolError("not_bookable", "This service can't be booked over WhatsApp.");
    const durationMin = durationOf(item, rules);
    if (durationMin === null)
      return toolError("no_duration", "This service has no duration configured.");
    const subject = cleanName(String(input.subject_name));
    if (!subject)
      return toolError("invalid_name", "Ask for the attendee's full name (letters only).");
    const partySize = typeof input.party_size === "number" ? input.party_size : undefined;
    if (rules.collect.includes("party_size") && partySize === undefined) {
      return toolError("missing_party_size", "Ask how many people will come.");
    }

    const start = DateTime.fromISO(String(input.starts_at), { setZone: true });
    const slot = await findSlot(ctx, rules, item, durationMin, start, { partySize });
    if (!slot.match) return unavailable(ctx, rules, slot.candidates, start);

    const proposalParams = {
      service_key: item.key,
      starts_at: start.toUTC().toISO() ?? "",
      subject_name: subject,
      for_self: input.for_self === true,
      party_size: partySize ?? null,
      notes: typeof input.notes === "string" ? input.notes.trim() || null : null,
    };
    const step = await confirmationStep(
      ctx,
      rules.requireConfirmation,
      "book",
      proposalParams,
      input,
      {
        service: item.name,
        ...slotView(start.toJSDate(), ctx.timezone),
        subject_name: subject,
        price_type: item.price_type ?? null,
        price_cop: item.price_cop ?? null,
      },
    );
    if ("outcome" in step) return step.outcome;

    for (const resourceId of slot.match.freeResourceIds) {
      try {
        const booking = await withTenant(ctx.db, ctx.business.id, async (tx) => {
          if (step.proposalId && !(await consumeProposal(tx, step.proposalId))) return null;
          const row = await insertBooking(tx, {
            businessId: ctx.business.id,
            contactId: ctx.contact.id,
            resourceId,
            serviceKey: item.key,
            serviceName: item.name,
            priceCop: typeof item.price_cop === "number" ? item.price_cop : null,
            subjectName: subject,
            partySize: partySize ?? null,
            startsAt: start.toJSDate(),
            endsAt: start.plus({ minutes: durationMin }).toJSDate(),
            source: "agent",
            notes: proposalParams.notes,
          });
          // Decision A10: the contact's name only ever comes from a name they typed for themselves.
          if (proposalParams.for_self) await setContactNameIfMissing(tx, ctx.contact.id, subject);
          return row;
        });
        if (!booking)
          return {
            result: { status: "already_done", message: "This proposal was already booked." },
          };
        await afterChange(ctx, "booking.created", booking);
        return { result: { status: "booked", booking: bookingView(ctx, booking) } };
      } catch (error) {
        if (!(error instanceof SlotTakenError)) throw error;
      }
    }
    // Every free resource was taken in the meantime (spec §6: "just taken, here are alternatives").
    const fresh = await findSlot(ctx, rules, item, durationMin, start, { partySize });
    return unavailable(ctx, rules, fresh.candidates, start, "slot_taken");
  },
};

// --- reschedule ----------------------------------------------------------------------------------

export const reschedule: AgentTool = {
  name: "reschedule",
  description:
    "Move one of the customer's bookings to a new time. Call find_bookings first to get the booking_id. " +
    "Same two steps as book: first with confirmed_by_customer=false to get a proposal to read back, then " +
    "with confirmed_by_customer=true and the proposal_id after the customer confirms.",
  input: () =>
    z.strictObject({
      booking_id: z.uuid(),
      new_starts_at: startsAt,
      confirmed_by_customer: confirmed,
      proposal_id: proposalId,
    }),
  async run(ctx, input, params) {
    const rules = effectiveRules(ctx, params);
    const booking = await activeBooking(ctx, String(input.booking_id));
    if (!booking)
      return toolError(
        "booking_not_found",
        "No active booking with that id for this customer; call find_bookings.",
      );
    const durationMin = Math.round(
      (booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000,
    );
    const item = findItem(catalogAt(ctx.config, rules.catalogPath), booking.serviceKey) ?? {
      key: booking.serviceKey,
      name: booking.serviceName,
    };
    const start = DateTime.fromISO(String(input.new_starts_at), { setZone: true });
    const slot = await findSlot(ctx, rules, item, durationMin, start, {
      partySize: booking.partySize ?? undefined,
      ignoreBookingId: booking.id,
    });
    if (!slot.match) return unavailable(ctx, rules, slot.candidates, start);

    const step = await confirmationStep(
      ctx,
      rules.requireConfirmation,
      "reschedule",
      { booking_id: booking.id, new_starts_at: start.toUTC().toISO() ?? "" },
      input,
      {
        service: booking.serviceName,
        from: slotView(booking.startsAt, ctx.timezone).label,
        to: slotView(start.toJSDate(), ctx.timezone).label,
        subject_name: booking.subjectName,
      },
    );
    if ("outcome" in step) return step.outcome;

    // Prefer keeping the same resource.
    const order = [...slot.match.freeResourceIds].sort(
      (a, b) => Number(b === booking.resourceId) - Number(a === booking.resourceId),
    );
    for (const resourceId of order) {
      try {
        const moved = await withTenant(ctx.db, ctx.business.id, async (tx) => {
          if (step.proposalId && !(await consumeProposal(tx, step.proposalId))) return null;
          return moveBooking(tx, booking.id, {
            startsAt: start.toJSDate(),
            endsAt: start.plus({ minutes: durationMin }).toJSDate(),
            resourceId,
          });
        });
        if (!moved)
          return { result: { status: "already_done", message: "This change was already made." } };
        await afterChange(ctx, "booking.rescheduled", moved);
        return { result: { status: "rescheduled", booking: bookingView(ctx, moved) } };
      } catch (error) {
        if (!(error instanceof SlotTakenError)) throw error;
      }
    }
    const fresh = await findSlot(ctx, rules, item, durationMin, start, {
      partySize: booking.partySize ?? undefined,
      ignoreBookingId: booking.id,
    });
    return unavailable(ctx, rules, fresh.candidates, start, "slot_taken");
  },
};

// --- cancel ----------------------------------------------------------------------------------------

export const cancel: AgentTool = {
  name: "cancel",
  description:
    "Cancel one of the customer's bookings. Call find_bookings first to get the booking_id. When confirmation is " +
    "required, the first call returns a proposal to read back; call again with confirmed_by_customer=true and the " +
    "proposal_id after the customer confirms.",
  input: () =>
    z.strictObject({
      booking_id: z.uuid(),
      confirmed_by_customer: confirmed,
      proposal_id: proposalId,
    }),
  async run(ctx, input, params) {
    const booking = await activeBooking(ctx, String(input.booking_id));
    if (!booking)
      return toolError(
        "booking_not_found",
        "No active booking with that id for this customer; call find_bookings.",
      );
    const step = await confirmationStep(
      ctx,
      params.require_confirmation !== false,
      "cancel",
      { booking_id: booking.id },
      input,
      {
        service: booking.serviceName,
        ...slotView(booking.startsAt, ctx.timezone),
        subject_name: booking.subjectName,
      },
    );
    if ("outcome" in step) return step.outcome;

    const cancelled = await withTenant(ctx.db, ctx.business.id, async (tx) => {
      if (step.proposalId && !(await consumeProposal(tx, step.proposalId))) return null;
      return cancelBooking(tx, booking.id);
    });
    if (!cancelled)
      return { result: { status: "already_done", message: "This booking was already cancelled." } };
    await afterChange(ctx, "booking.cancelled", cancelled);
    return { result: { status: "cancelled", booking: bookingView(ctx, cancelled) } };
  },
};

// --- find_bookings -------------------------------------------------------------------------------

export const findBookings: AgentTool = {
  name: "find_bookings",
  description:
    "List the customer's upcoming bookings (with their booking_id). Set include_past to also see past ones.",
  input: () => z.strictObject({ include_past: z.boolean().optional() }),
  async run(ctx, input) {
    const rows = await withTenant(ctx.db, ctx.business.id, (tx) =>
      listContactBookings(tx, ctx.contact.id, {
        from: ctx.now,
        includePast: input.include_past === true,
      }),
    );
    return { result: { bookings: rows.map((b) => bookingView(ctx, b)) } };
  },
};

// --- helpers -------------------------------------------------------------------------------------

/** Letters, spaces, apostrophes, hyphens and dots; at least two letters (decision A10). */
export function cleanName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length > 80 || !/^[\p{L}][\p{L} .'-]*$/u.test(name)) return null;
  return (name.match(/\p{L}/gu)?.length ?? 0) >= 2 ? name : null;
}

async function activeBooking(ctx: ToolContext, bookingId: string): Promise<BookingRow | null> {
  const booking = await withTenant(ctx.db, ctx.business.id, (tx) =>
    getContactBooking(tx, bookingId, ctx.contact.id),
  );
  return booking && (booking.status === "pending" || booking.status === "confirmed")
    ? booking
    : null;
}

async function findSlot(
  ctx: ToolContext,
  rules: EffectiveRules,
  item: CatalogItem,
  durationMin: number,
  start: DateTime,
  options: { partySize?: number | undefined; ignoreBookingId?: string | undefined },
): Promise<{ match: Candidate | null; candidates: Candidate[] }> {
  if (!start.isValid) return { match: null, candidates: [] };
  const day = localDate(start.toJSDate(), ctx.timezone);
  const candidates = await searchSlots(ctx, {
    item,
    rules,
    durationMin,
    dateFrom: day,
    dateTo: day,
    ...options,
  });
  const match = candidates.find((c) => c.start.getTime() === start.toMillis()) ?? null;
  return { match, candidates };
}

function unavailable(
  ctx: ToolContext,
  rules: EffectiveRules,
  candidates: Candidate[],
  start: DateTime,
  status = "unavailable",
): ToolOutcome {
  const around = start.isValid ? start.setZone(ctx.timezone).toFormat("HH:mm") : undefined;
  const offer = chooseSlots(candidates, rules.slotsToOffer, around);
  return {
    result: {
      status,
      message:
        status === "slot_taken" ? "That time was just taken." : "That time is not available.",
      alternatives: offer.slots.map((s) => slotView(s.start, ctx.timezone)),
    },
  };
}

type Step = { proposalId: string | null } | { outcome: ToolOutcome };

/**
 * Decision A5. Proceeds when confirmation isn't required, or when the customer confirmed
 * and a matching proposal exists from an earlier turn. Otherwise records a proposal and
 * returns the summary to read back.
 */
async function confirmationStep(
  ctx: ToolContext,
  required: boolean,
  action: BookingProposalRow["action"],
  params: Record<string, unknown>,
  input: Record<string, unknown>,
  summary: Record<string, unknown>,
): Promise<Step> {
  if (!required) return { proposalId: null };
  const open = await withTenant(ctx.db, ctx.business.id, (tx) =>
    listOpenProposals(tx, ctx.conversation.id, ctx.now),
  );
  // Only a proposal with exactly these details counts: a proposal_id alone could carry a
  // confirmation over to a different time, service or person.
  const matching = open.filter((p) => p.action === action && sameParams(action, p.params, params));
  const shown = matching.filter((p) => !ctx.batchMessageIds.has(p.turnId));
  const earlier = shown.find((p) => p.id === input.proposal_id) ?? shown[0];
  if (input.confirmed_by_customer === true && earlier) return { proposalId: earlier.id };

  const sameTurn = matching.find((p) => ctx.batchMessageIds.has(p.turnId));
  const proposal =
    sameTurn ??
    (await withTenant(ctx.db, ctx.business.id, (tx) =>
      createProposal(tx, {
        businessId: ctx.business.id,
        conversationId: ctx.conversation.id,
        action,
        params,
        turnId: ctx.turnId,
        expiresAt: new Date(ctx.now.getTime() + PROPOSAL_TTL_MS),
      }),
    ));
  const early = input.confirmed_by_customer === true;
  return {
    outcome: {
      result: {
        status: "needs_confirmation",
        proposal_id: proposal.id,
        summary,
        next_step: CONFIRM_STEP,
        ...(early
          ? { note: "The customer hasn't confirmed this yet in an earlier message: ask first." }
          : {}),
      },
    },
  };
}

function sameParams(
  action: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  if (action === "book") {
    return (
      a.service_key === b.service_key &&
      instant(a.starts_at) === instant(b.starts_at) &&
      normalize(String(a.subject_name)) === normalize(String(b.subject_name)) &&
      (a.party_size ?? null) === (b.party_size ?? null)
    );
  }
  if (action === "reschedule")
    return a.booking_id === b.booking_id && instant(a.new_starts_at) === instant(b.new_starts_at);
  return a.booking_id === b.booking_id;
}

function instant(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function bookingView(ctx: ToolContext, booking: BookingRow): Record<string, unknown> {
  return {
    id: booking.id,
    service_name: booking.serviceName,
    subject_name: booking.subjectName,
    status: booking.status,
    ...slotView(booking.startsAt, ctx.timezone),
  };
}

async function afterChange(
  ctx: ToolContext,
  type: "booking.created" | "booking.rescheduled" | "booking.cancelled",
  booking: BookingRow,
): Promise<void> {
  const event = { type, businessId: ctx.business.id, bookingId: booking.id, at: ctx.now };
  await ctx.events.emit(event);
  const providerBooking = {
    id: booking.id,
    resourceId: booking.resourceId,
    start: booking.startsAt,
    end: booking.endsAt,
    title: `${booking.serviceName} — ${booking.subjectName}`,
    externalRef: booking.externalRef,
  };
  if (type === "booking.created") await ctx.provider.createEvent(providerBooking);
  else if (type === "booking.rescheduled") await ctx.provider.updateEvent(providerBooking);
  else await ctx.provider.deleteEvent(providerBooking);
}
