import {
  dueBookingChanges,
  dueBookingCompletions,
  dueBookingStarts,
  dueContactDates,
  dueInactiveConversations,
  getTemplateVersion,
  insertRuns,
  listActiveBusinesses,
  listAutomations,
  listDueRuns,
  preparedTemplateFor,
  withTenant,
  type AutomationRow,
  type BusinessRow,
  type Database,
  type NewRun,
  type Transaction,
} from "@platform/db";
import { alert, type Logger } from "@platform/shared";
import { cronTicks } from "./cron.ts";
import type { QueuedRun } from "./deps.ts";
import { effectiveTrigger, findRule, minutesParam, type EffectiveTrigger } from "./rules.ts";

/**
 * The sweeper (spec §9), every minute: for each enabled rule of each active business,
 * the subjects whose fire time falls in (now − lookback, now] become runs. The insert is
 * `ON CONFLICT DO NOTHING` on the occurrence key, so only new runs are enqueued and a rule
 * fires at most once per occurrence however often this runs (principle 8). The 2-hour
 * lookback covers downtime.
 */

export const SWEEP_LOOKBACK_MS = 2 * 60 * 60_000;
export const SWEEP_EVERY_MS = 60_000;

export interface SweepDeps {
  db: Database;
  logger: Logger;
  now: () => Date;
  enqueue: (run: QueuedRun) => Promise<void>;
}

export async function sweepAutomations(
  deps: SweepDeps,
): Promise<{ inserted: number; requeued: number }> {
  const now = deps.now();
  const from = new Date(now.getTime() - SWEEP_LOOKBACK_MS);
  let inserted = 0;
  for (const business of await listActiveBusinesses(deps.db)) {
    try {
      const runs = await withTenant(deps.db, business.id, (tx) =>
        newRunsFor(tx, business, from, now),
      );
      for (const run of runs) await deps.enqueue(run);
      inserted += runs.length;
    } catch (error) {
      // One broken business must not stop the others.
      alert(
        deps.logger,
        "automation_sweep_failed",
        { business_id: business.id, err: error },
        "sweep failed for a business",
      );
    }
  }
  // Runs that are due but still scheduled may have lost their job (crash, Redis flush).
  // Re-enqueueing is harmless: the job id dedupes, and a finished run is a no-op.
  const due = await listDueRuns(deps.db, new Date(now.getTime() - SWEEP_EVERY_MS));
  for (const run of due) await deps.enqueue(run);
  if (inserted > 0 || due.length > 0) {
    deps.logger.info({ inserted, requeued: due.length }, "automations swept");
  }
  return { inserted, requeued: due.length };
}

async function newRunsFor(tx: Transaction, business: BusinessRow, from: Date, to: Date) {
  const row = await getTemplateVersion(tx, business.templateSlug, business.templateVersion);
  if (!row) return [];
  const template = preparedTemplateFor(row).template;
  const runs: NewRun[] = [];
  for (const automation of await listAutomations(tx, business.id)) {
    if (!automation.enabled) continue;
    const rule = findRule(template, automation.ruleKey);
    const trigger = rule ? effectiveTrigger(rule, automation.overrides) : null;
    if (!trigger) continue;
    runs.push(...(await dueRuns(tx, business, automation, trigger, from, to)));
  }
  return insertRuns(tx, runs);
}

/** The subjects of one rule that are due in (from, to], as runs. */
async function dueRuns(
  tx: Transaction,
  business: BusinessRow,
  automation: AutomationRow,
  trigger: EffectiveTrigger,
  from: Date,
  to: Date,
): Promise<NewRun[]> {
  const base = { businessId: business.id, automationId: automation.id };
  const { params } = trigger;
  switch (trigger.type) {
    case "booking.starts_in":
      return (
        await dueBookingStarts(tx, business.id, minutesParam(params, "offset"), from, to)
      ).map((b) => ({
        ...base,
        subjectType: "booking",
        subjectId: b.id,
        occurrenceKey: b.startsAt.toISOString(),
        dueAt: b.fireAt,
      }));
    case "booking.completed":
      return (
        await dueBookingCompletions(tx, business.id, minutesParam(params, "offset"), from, to)
      ).map((b) => ({
        ...base,
        subjectType: "booking",
        subjectId: b.id,
        occurrenceKey: "completed",
        dueAt: b.fireAt,
      }));
    case "booking.created":
    case "booking.rescheduled":
    case "booking.cancelled": {
      const change = trigger.type.slice("booking.".length) as
        "created" | "rescheduled" | "cancelled";
      return (await dueBookingChanges(tx, business.id, change, from, to)).map((b) => ({
        ...base,
        subjectType: "booking",
        subjectId: b.id,
        occurrenceKey: bookingChangeOccurrence(change, b.at),
        dueAt: b.at,
      }));
    }
    case "contact.date_field":
      return (
        await dueContactDates(tx, {
          businessId: business.id,
          field: String(params.field),
          offsetMin: minutesParam(params, "offset"),
          atLocalTime: String(params.at_local_time),
          timezone: business.timezone,
          from,
          to,
        })
      ).map((c) => ({
        ...base,
        subjectType: "contact",
        subjectId: c.id,
        occurrenceKey: c.date,
        dueAt: c.fireAt,
      }));
    case "conversation.inactive":
      return (
        await dueInactiveConversations(tx, business.id, minutesParam(params, "duration"), from, to)
      ).map((c) => ({
        ...base,
        subjectType: "conversation",
        subjectId: c.id,
        occurrenceKey: c.lastInboundAt.toISOString(),
        dueAt: new Date(c.lastInboundAt.getTime() + minutesParam(params, "duration") * 60_000),
      }));
    case "schedule":
      return cronTicks(String(params.cron), business.timezone, from, to).map((tick) => ({
        ...base,
        subjectType: "business",
        subjectId: business.id,
        occurrenceKey: tick.toISOString(),
        dueAt: tick,
      }));
  }
}

/**
 * Occurrence keys of booking changes (spec §9: the event). A booking is created and
 * cancelled once; each reschedule is its own occurrence.
 */
export function bookingChangeOccurrence(
  change: "created" | "rescheduled" | "cancelled",
  at: Date,
): string {
  return change === "rescheduled" ? at.toISOString() : change;
}
