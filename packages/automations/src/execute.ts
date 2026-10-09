import {
  ensureConversation,
  finishRun,
  getAutomation,
  getBooking,
  getBusiness,
  getContact,
  getConversation,
  getRun,
  getTemplateVersion,
  hasFutureBooking,
  hasSentRun,
  listAutomations,
  postponeRun,
  preparedTemplateFor,
  withTenant,
  type AutomationRunRow,
  type BookingRow,
  type BusinessRow,
  type ContactRow,
  type ConversationRow,
  type Transaction,
} from "@platform/db";
import { alert } from "@platform/shared";
import type { Automation, Condition, PreparedTemplate } from "@platform/templates";
import {
  notifyStaffAction,
  sendTemplateAction,
  sendTextAction,
  updateBookingAction,
  updateContactAction,
  type ActionResult,
  type ActionTarget,
} from "./actions.ts";
import { fieldConditionHolds, quietHoursEnd } from "./conditions.ts";
import { automationContext } from "./context.ts";
import type { AutomationDeps } from "./deps.ts";
import { effectiveTrigger, findRule, type EffectiveTrigger } from "./rules.ts";

/**
 * Runs one scheduled firing of a rule (spec §9). Everything is checked at send time: the
 * occurrence is still current (B29), the contact can be messaged (not opted out, consent
 * given: A13), the rule's conditions hold, quiet hours. A run ends exactly once.
 */

export type RunOutcome =
  | { status: "sent" | "skipped" | "failed"; reason?: string }
  | { status: "postponed"; until: Date }
  | { status: "not_scheduled" }
  | { status: "not_due" };

interface Loaded {
  run: AutomationRunRow;
  business: BusinessRow;
  prepared: PreparedTemplate;
  rule: Automation;
  trigger: EffectiveTrigger;
  booking: BookingRow | null;
  contact: ContactRow | null;
  conversation: ConversationRow | null;
}

export async function executeRun(
  deps: AutomationDeps,
  job: { runId: string; businessId: string },
): Promise<RunOutcome> {
  const now = deps.now();
  const loaded = await load(deps, job, now);
  if ("outcome" in loaded) return loaded.outcome;
  const { run, business, prepared, rule, contact, booking, conversation } = loaded;
  const log = deps.logger.child({ business_id: business.id, run_id: run.id, rule: rule.key });

  const end = async (result: ActionResult): Promise<RunOutcome> => {
    const status = result.status === "done" ? "sent" : result.status;
    const reason = result.status === "done" ? null : result.reason;
    await withTenant(deps.db, business.id, (tx) =>
      finishRun(tx, run.id, {
        status,
        reason,
        error:
          result.status === "failed"
            ? result.error
            : result.status === "skipped"
              ? (result.details ?? null)
              : null,
        sentMessageId: result.status === "done" ? (result.messageId ?? null) : null,
      }),
    );
    if (result.status === "failed") {
      alert(log, "automation_failed", { reason, error: result.error }, "automation run failed");
    } else {
      log.info({ status, reason }, "automation run finished");
    }
    return reason === null ? { status } : { status, reason };
  };

  // Spec §9 and decision A13: always applied, whatever the rule says.
  if (contact?.optedOutAt) return end({ status: "skipped", reason: "opted_out" });
  if (contact && !contact.consentAt) return end({ status: "skipped", reason: "no_consent" });

  const context = await withTenant(deps.db, business.id, (tx) =>
    automationContext(tx, { business, prepared, contact, booking, now }),
  );
  for (const condition of rule.conditions) {
    const failed = await failedCondition(deps, loaded, condition, context, now);
    if (failed) return end({ status: "skipped", reason: failed });
  }
  if (rule.conditions.some((c) => c.builtin === "quiet_hours")) {
    const until = quietHoursEnd(now, business.timezone);
    if (until) {
      await withTenant(deps.db, business.id, (tx) => postponeRun(tx, run.id, until));
      await deps.enqueue({ id: run.id, businessId: business.id, dueAt: until });
      log.info({ until: until.toISOString() }, "automation postponed for quiet hours");
      return { status: "postponed", until };
    }
  }

  const target: ActionTarget = {
    business,
    prepared,
    ruleKey: rule.key,
    runId: run.id,
    booking,
    contact,
    conversation,
    context,
    now,
  };
  const { type, ...params } = rule.action;
  const key = `run:${run.id}`;
  switch (type) {
    case "send_template":
      return end(await sendTemplateAction(deps, target, String(params.template), key));
    case "send_text":
      return end(await sendTextAction(deps, target, String(params.text), key));
    case "update_booking":
      return end(await updateBookingAction(deps, target, params));
    case "update_contact":
      return end(await updateContactAction(deps, target, params));
    case "notify_staff":
      return end(await notifyStaffAction(deps, target, params, key));
    case "start_agent":
      // The agent answers messages; with nothing from the customer to answer, it can't
      // start a conversation (it would need a template outside the 24-hour window).
      return end({ status: "skipped", reason: "needs_customer_message" });
    default:
      return end({ status: "failed", reason: "unknown_action", error: { type } });
  }
}

/** Marks a run failed after its job used up every attempt (the worker's failed handler). */
export async function failRun(
  deps: Pick<AutomationDeps, "db" | "logger">,
  job: { runId: string; businessId: string },
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const ended = await withTenant(deps.db, job.businessId, (tx) =>
    finishRun(tx, job.runId, { status: "failed", reason: "job_failed", error: { message } }),
  );
  if (ended) {
    alert(
      deps.logger,
      "automation_failed",
      { business_id: job.businessId, run_id: job.runId, err: error },
      "automation run failed for good",
    );
  }
}

type LoadStep =
  | { kind: "not_scheduled" }
  | { kind: "early"; run: AutomationRunRow }
  | { kind: "skip"; run: AutomationRunRow; reason: string }
  | { kind: "loaded"; loaded: Loaded };

async function load(
  deps: AutomationDeps,
  job: { runId: string; businessId: string },
  now: Date,
): Promise<Loaded | { outcome: RunOutcome }> {
  const step = await withTenant(deps.db, job.businessId, async (tx): Promise<LoadStep> => {
    const run = await getRun(tx, job.runId);
    if (run?.status !== "scheduled") return { kind: "not_scheduled" };
    // A job can run early when re-enqueued with a stale delay; the run waits for its time.
    if (run.dueAt.getTime() > now.getTime() + 1000) return { kind: "early", run };

    const skip = (reason: string): LoadStep => ({ kind: "skip", run, reason });
    const automation = await getAutomation(tx, run.automationId);
    const business = await getBusiness(tx, run.businessId);
    if (!automation || !business) return skip("missing");
    if (business.status !== "active") return skip("business_not_active");
    if (!automation.enabled) return skip("disabled");
    const row = await getTemplateVersion(tx, business.templateSlug, business.templateVersion);
    if (!row) return skip("template_missing");
    const prepared = preparedTemplateFor(row);
    const rule = findRule(prepared.template, automation.ruleKey);
    const trigger = rule ? effectiveTrigger(rule, automation.overrides) : null;
    if (!rule || !trigger) return skip("rule_removed");

    const subject = await loadSubject(tx, run);
    if (!subject) return skip("subject_missing");
    if (!occurrenceCurrent(trigger, run, subject)) return skip("stale_occurrence");
    const conversation =
      subject.conversation ??
      (subject.contact ? await ensureConversation(tx, business.id, subject.contact.id) : null);
    return {
      kind: "loaded",
      loaded: { run, business, prepared, rule, trigger, ...subject, conversation },
    };
  });

  switch (step.kind) {
    case "not_scheduled":
      return { outcome: { status: "not_scheduled" } };
    case "early":
      await deps.enqueue({ id: step.run.id, businessId: job.businessId, dueAt: step.run.dueAt });
      return { outcome: { status: "not_due" } };
    case "skip":
      await withTenant(deps.db, job.businessId, (tx) =>
        finishRun(tx, step.run.id, { status: "skipped", reason: step.reason }),
      );
      deps.logger.info(
        { business_id: job.businessId, run_id: step.run.id, reason: step.reason },
        "automation run skipped",
      );
      return { outcome: { status: "skipped", reason: step.reason } };
    case "loaded":
      return step.loaded;
  }
}

async function loadSubject(
  tx: Transaction,
  run: AutomationRunRow,
): Promise<{
  booking: BookingRow | null;
  contact: ContactRow | null;
  conversation: ConversationRow | null;
} | null> {
  switch (run.subjectType) {
    case "booking": {
      const booking = await getBooking(tx, run.subjectId);
      const contact = booking ? await getContact(tx, booking.contactId) : null;
      return booking && contact ? { booking, contact, conversation: null } : null;
    }
    case "contact": {
      const contact = await getContact(tx, run.subjectId);
      return contact ? { booking: null, contact, conversation: null } : null;
    }
    case "conversation": {
      const conversation = await getConversation(tx, run.subjectId);
      const contact = conversation ? await getContact(tx, conversation.contactId) : null;
      return conversation && contact ? { booking: null, contact, conversation } : null;
    }
    case "business":
      return { booking: null, contact: null, conversation: null };
  }
}

/** Spec review B29: a run whose subject changed since it was scheduled never fires. */
function occurrenceCurrent(
  trigger: EffectiveTrigger,
  run: AutomationRunRow,
  subject: {
    booking: BookingRow | null;
    contact: ContactRow | null;
    conversation: ConversationRow | null;
  },
): boolean {
  const { booking, contact, conversation } = subject;
  const key = run.occurrenceKey;
  switch (trigger.type) {
    case "booking.starts_in":
      return (
        booking !== null &&
        (booking.status === "pending" || booking.status === "confirmed") &&
        booking.startsAt.toISOString() === key
      );
    case "booking.completed":
      return booking?.status === "completed";
    case "booking.created":
      return booking !== null;
    case "booking.rescheduled":
      return booking?.rescheduledAt?.toISOString() === key;
    case "booking.cancelled":
      return booking?.status === "cancelled";
    case "contact.date_field": {
      const field = String(trigger.params.field);
      return contact !== null && contact.fields[field] === key;
    }
    case "conversation.inactive":
      return conversation?.lastInboundAt?.toISOString() === key;
    case "schedule":
      return true;
  }
}

/** The reason a condition fails, or null when it holds. */
async function failedCondition(
  deps: AutomationDeps,
  loaded: Loaded,
  condition: Condition,
  context: Record<string, unknown>,
  now: Date,
): Promise<string | null> {
  const { business, contact, run, prepared, trigger } = loaded;
  switch (condition.builtin) {
    case undefined:
      return fieldConditionHolds(condition, context) ? null : `condition:${condition.field ?? ""}`;
    case "not_opted_out":
    case "has_consent":
    case "quiet_hours":
      return null; // always applied above / handled after the other conditions
    case "no_future_booking": {
      if (!contact) return null;
      const future = await withTenant(deps.db, business.id, (tx) =>
        hasFutureBooking(tx, contact.id, now),
      );
      return future ? "future_booking" : null;
    }
    case "run_sent": {
      const other = condition.rule ? findRule(prepared.template, condition.rule) : null;
      if (!other) return "run_not_sent";
      // Spec review B30: same subject; same occurrence too when both rules are starts_in.
      const sameOccurrence =
        trigger.type === "booking.starts_in" && other.trigger.type === "booking.starts_in";
      const sent = await withTenant(deps.db, business.id, async (tx) => {
        const automation = (await listAutomations(tx, business.id)).find(
          (a) => a.ruleKey === other.key,
        );
        if (!automation) return false;
        return hasSentRun(tx, {
          automationId: automation.id,
          subjectType: run.subjectType,
          subjectId: run.subjectId,
          ...(sameOccurrence ? { occurrenceKey: run.occurrenceKey } : {}),
        });
      });
      return sent ? null : "run_not_sent";
    }
  }
}
