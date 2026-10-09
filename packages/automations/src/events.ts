import type { BookingEvent, EventSink } from "@platform/core";
import {
  getBooking,
  getBusiness,
  getTemplateVersion,
  insertRuns,
  listAutomations,
  preparedTemplateFor,
  withTenant,
  type Transaction,
} from "@platform/db";
import { alert } from "@platform/shared";
import { effectiveTrigger, findRule } from "./rules.ts";
import { bookingChangeOccurrence, type SweepDeps } from "./sweep.ts";

/**
 * Booking events (spec §9: event triggers insert runs directly). booking.created,
 * rescheduled and cancelled become runs right away. booking.completed rules have an offset,
 * so the sweeper fires them. A failure here never fails the booking: the sweeper finds the
 * same occurrences from the booking's timestamps within a minute.
 */
export function createAutomationEventSink(deps: SweepDeps): EventSink {
  return {
    async emit(event) {
      deps.logger.info(
        { event: event.type, business_id: event.businessId, booking_id: event.bookingId },
        "booking event",
      );
      if (event.type === "booking.completed") return;
      try {
        const runs = await withTenant(deps.db, event.businessId, (tx) => runsFor(tx, event));
        for (const run of runs) await deps.enqueue(run);
      } catch (error) {
        alert(
          deps.logger,
          "automation_event_failed",
          { business_id: event.businessId, booking_id: event.bookingId, err: error },
          "booking event not turned into runs; the sweeper will catch up",
        );
      }
    },
  };
}

async function runsFor(tx: Transaction, event: BookingEvent) {
  const business = await getBusiness(tx, event.businessId);
  const booking = await getBooking(tx, event.bookingId);
  if (business?.status !== "active" || !booking) return [];
  const row = await getTemplateVersion(tx, business.templateSlug, business.templateVersion);
  if (!row) return [];
  const template = preparedTemplateFor(row).template;
  const change = event.type.slice("booking.".length) as "created" | "rescheduled" | "cancelled";
  const at = change === "rescheduled" ? (booking.rescheduledAt ?? event.at) : event.at;

  const runs = [];
  for (const automation of await listAutomations(tx, business.id)) {
    const rule = automation.enabled ? findRule(template, automation.ruleKey) : null;
    if (!rule || effectiveTrigger(rule, automation.overrides)?.type !== event.type) continue;
    runs.push({
      businessId: business.id,
      automationId: automation.id,
      subjectType: "booking" as const,
      subjectId: booking.id,
      occurrenceKey: bookingChangeOccurrence(change, at),
      dueAt: at,
    });
  }
  return insertRuns(tx, runs);
}
