import { serviceWindow } from "@platform/channels";
import { WindowClosedError, monthStart, sendTemplate, sendText, warnOnUsage } from "@platform/core";
import {
  cancelBooking,
  confirmBooking,
  countTemplateMessagesSince,
  getMessageByIdempotencyKey,
  getWaTemplate,
  notifyStaff,
  setContactFields,
  withTenant,
  type BookingRow,
  type BusinessRow,
  type ContactRow,
  type ConversationRow,
  type MessageRow,
} from "@platform/db";
import {
  metaTemplateName,
  parseSemver,
  type Context,
  type PreparedTemplate,
} from "@platform/templates";
import { renderText } from "./context.ts";
import type { AutomationDeps } from "./deps.ts";
import { encodeButtonPayload } from "./payload.ts";
import { fillBody, resolveVariables } from "./variables.ts";

/**
 * The actions of spec §9, shared by scheduled runs and button replies. Each is safe to
 * repeat: messages carry an idempotency key, notifications a dedupe key, and data
 * changes only apply once (a booking confirms only while pending).
 */

export interface ActionTarget {
  business: BusinessRow;
  prepared: PreparedTemplate;
  ruleKey: string;
  /** The run that fired the rule (button payloads point back to it). */
  runId: string;
  booking: BookingRow | null;
  contact: ContactRow | null;
  conversation: ConversationRow | null;
  context: Context;
  now: Date;
}

export type ActionResult =
  | { status: "done"; messageId?: string }
  | { status: "skipped"; reason: string; details?: Record<string, unknown> }
  | { status: "failed"; reason: string; error: Record<string, unknown> };

const skipped = (reason: string, details?: Record<string, unknown>): ActionResult => ({
  status: "skipped",
  reason,
  ...(details ? { details } : {}),
});

// --- data ------------------------------------------------------------------------------------

export async function updateBookingAction(
  deps: AutomationDeps,
  target: ActionTarget,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const { booking, business } = target;
  if (!booking) return skipped("no_booking");
  const status = (params.set as { status?: unknown } | undefined)?.status;
  if (status === "confirmed") {
    const confirmed = await withTenant(deps.db, business.id, (tx) =>
      confirmBooking(tx, booking.id),
    );
    // Already confirmed is fine; cancelled or past bookings stay as they are.
    if (confirmed || booking.status === "confirmed") return { status: "done" };
    return skipped("booking_not_pending", { booking_status: booking.status });
  }
  if (status === "cancelled") {
    const cancelled = await withTenant(deps.db, business.id, (tx) => cancelBooking(tx, booking.id));
    if (!cancelled) return skipped("booking_not_active", { booking_status: booking.status });
    await deps.events.emit({
      type: "booking.cancelled",
      businessId: business.id,
      bookingId: booking.id,
      at: target.now,
    });
    await deps.provider.deleteEvent({
      id: cancelled.id,
      resourceId: cancelled.resourceId,
      start: cancelled.startsAt,
      end: cancelled.endsAt,
      title: `${cancelled.serviceName} — ${cancelled.subjectName}`,
      externalRef: cancelled.externalRef,
    });
    return { status: "done" };
  }
  return { status: "failed", reason: "unsupported_update", error: { status: String(status) } };
}

export async function updateContactAction(
  deps: AutomationDeps,
  target: ActionTarget,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const { contact, business, prepared } = target;
  if (!contact) return skipped("no_contact");
  const compiled = prepared.contactFields;
  if (!compiled) return { status: "failed", reason: "no_contact_fields", error: {} };
  const set = (params.set ?? {}) as Record<string, unknown>;
  const changes = Object.fromEntries(
    Object.entries(set).map(([field, value]) => [
      field,
      typeof value === "string" ? renderText(value, target.context) : value,
    ]),
  );
  const fields = { ...contact.fields, ...changes };
  if (!compiled.validate(structuredClone(fields))) {
    return {
      status: "failed",
      reason: "invalid_contact_value",
      error: { fields: Object.keys(changes), details: compiled.validate.errors?.[0]?.message },
    };
  }
  await withTenant(deps.db, business.id, (tx) => setContactFields(tx, contact.id, fields));
  return { status: "done" };
}

export async function notifyStaffAction(
  deps: AutomationDeps,
  target: ActionTarget,
  params: Record<string, unknown>,
  dedupeKey: string,
  kind: "automation" | "button" = "automation",
): Promise<ActionResult> {
  const text = renderText(String(params.text), target.context);
  await withTenant(deps.db, target.business.id, (tx) =>
    notifyStaff(tx, {
      businessId: target.business.id,
      kind,
      text,
      payload: links(target),
      dedupeKey,
    }),
  );
  return { status: "done" };
}

/** Ids the admin uses to link a notification to its conversation and booking. */
export function links(target: ActionTarget): Record<string, unknown> {
  return {
    rule_key: target.ruleKey,
    run_id: target.runId,
    booking_id: target.booking?.id ?? null,
    contact_id: target.contact?.id ?? null,
    conversation_id: target.conversation?.id ?? null,
  };
}

// --- messages ----------------------------------------------------------------------------------

/**
 * send_template (spec §9): only an APPROVED template goes out (B31: with Meta's category),
 * within the marketing cap, with every parameter filled in (A10).
 */
export async function sendTemplateAction(
  deps: AutomationDeps,
  target: ActionTarget,
  templateKey: string,
  idempotencyKey: string,
): Promise<ActionResult> {
  const { business, prepared, contact, conversation } = target;
  const wa = prepared.template.wa_templates.find((t) => t.key === templateKey);
  if (!wa) return { status: "failed", reason: "unknown_template", error: { templateKey } };
  if (!contact || !conversation) return skipped("no_recipient");
  const major = parseSemver(prepared.template.manifest.version)?.major ?? 1;
  const name = metaTemplateName(wa.key, major);
  const row = await withTenant(deps.db, business.id, (tx) =>
    getWaTemplate(tx, business.id, name, wa.language),
  );
  if (row?.metaStatus !== "APPROVED") {
    return skipped("template_not_approved", {
      template: name,
      meta_status: row?.metaStatus ?? null,
    });
  }

  const category = row.categoryMeta ?? row.categoryRequested;
  const marketing =
    category === "MARKETING" ? await marketingUsage(deps, business, target.now) : null;
  if (marketing && marketing.sent >= marketing.cap) return skipped("marketing_cap", marketing);

  const resolved = resolveVariables(wa, target.context);
  if (!resolved.ok) return skipped("missing_variable", { variable: resolved.missing });
  const buttons = wa.buttons.map((b) => ({
    text: b.text,
    payload: encodeButtonPayload({
      ruleKey: target.ruleKey,
      runId: target.runId,
      payload: b.payload,
    }),
  }));
  await sendTemplate(deps, {
    businessId: business.id,
    conversationId: conversation.id,
    template: {
      name,
      languageCode: wa.language,
      bodyParameters: resolved.values,
      quickReplyPayloads: buttons.map((b) => b.payload),
    },
    idempotencyKey,
    preview: fillBody(wa.body, resolved.values),
    category,
    buttons,
    details: { rule_key: target.ruleKey, run_id: target.runId },
  });
  const result = await messageResult(deps, business.id, idempotencyKey);
  if (marketing && result.status === "done") {
    await warnOnUsage(deps, {
      businessId: business.id,
      cap: "marketing",
      used: marketing.sent + 1,
      limit: marketing.cap,
      now: target.now,
      timezone: business.timezone,
    });
  }
  return result;
}

/** send_text: free-form text, only inside the 24-hour window (spec §9). */
export async function sendTextAction(
  deps: AutomationDeps,
  target: ActionTarget,
  text: string,
  idempotencyKey: string,
): Promise<ActionResult> {
  const { business, contact, conversation } = target;
  if (!contact || !conversation) return skipped("no_recipient");
  if (!serviceWindow(conversation.lastInboundAt, target.now).open) return skipped("window_closed");
  try {
    await sendText(deps, {
      businessId: business.id,
      conversationId: conversation.id,
      body: renderText(text, target.context),
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof WindowClosedError) return skipped("window_closed");
    throw error;
  }
  return messageResult(deps, business.id, idempotencyKey);
}

async function marketingUsage(
  deps: AutomationDeps,
  business: BusinessRow,
  now: Date,
): Promise<{ sent: number; cap: number }> {
  const sent = await withTenant(deps.db, business.id, (tx) =>
    countTemplateMessagesSince(tx, business.id, "MARKETING", monthStart(now, business.timezone)),
  );
  return { sent, cap: business.limits.marketing_msgs_month ?? deps.marketingMsgsMonth };
}

/** After queueing a message: done once Meta took it (or the outcome is unknown, B15). */
async function messageResult(
  deps: AutomationDeps,
  businessId: string,
  idempotencyKey: string,
): Promise<ActionResult> {
  const message: MessageRow | null = await withTenant(deps.db, businessId, (tx) =>
    getMessageByIdempotencyKey(tx, businessId, idempotencyKey),
  );
  if (!message) return { status: "failed", reason: "message_missing", error: {} };
  if (message.status === "failed") {
    return { status: "failed", reason: "send_failed", error: message.error ?? {} };
  }
  return { status: "done", messageId: message.id };
}
