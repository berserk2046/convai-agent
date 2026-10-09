import { normalize, type ButtonHandler, type ButtonInput, type Reply } from "@platform/core";
import {
  getAutomation,
  getBooking,
  getConversation,
  getRun,
  lastOutboundMessage,
  notifyStaff,
  withTenant,
  type AutomationRunRow,
  type BookingRow,
} from "@platform/db";
import { formatSlotLabel } from "@platform/shared";
import { DateTime } from "luxon";
import {
  links,
  notifyStaffAction,
  sendTemplateAction,
  updateBookingAction,
  updateContactAction,
  type ActionTarget,
} from "./actions.ts";
import { automationContext, renderText } from "./context.ts";
import type { AutomationDeps } from "./deps.ts";
import { decodeButtonPayload, type ButtonPayload } from "./payload.ts";
import { findRule } from "./rules.ts";

/**
 * Template button replies (spec §9). A tap's payload `<rule_key>:<run_id>:<payload>` leads
 * to the run that sent the template and the rule's `on_button.<payload>` actions.
 * - Typing a button's text counts as tapping it, when a template from the past 72 hours is
 *   the last message we sent (decision A11).
 * - During a handoff, data actions still run, but nothing is said to the customer and staff
 *   get a notification instead (decision A12).
 * - A tap on a message about a booking that moved or ended since then does nothing; the
 *   agent explains instead.
 */

const TYPED_REPLY_WINDOW_MS = 72 * 60 * 60_000;

interface Tap {
  payload: ButtonPayload;
  text: string;
  /** The inbound message of the tap: keys its notifications and messages. */
  messageId: string;
}

export function createButtonHandler(deps: AutomationDeps): ButtonHandler {
  return async (input) => {
    const tap = await findTap(deps, input);
    return tap ? handleTap(deps, input, tap) : null;
  };
}

async function findTap(deps: AutomationDeps, input: ButtonInput): Promise<Tap | null> {
  for (const message of [...input.messages].reverse()) {
    if (message.type !== "button") continue;
    const raw = message.payload.message as { button?: { payload?: unknown; text?: unknown } };
    const payload =
      typeof raw.button?.payload === "string" ? decodeButtonPayload(raw.button.payload) : null;
    if (payload) {
      const text = typeof raw.button?.text === "string" ? raw.button.text : (message.body ?? "");
      return { payload, text, messageId: message.id };
    }
  }
  const typed = normalize(input.text);
  const last = input.messages.at(-1);
  if (typed === "" || !last) return null;
  // Only while the template is the last thing we said: a "confirmo" after the agent read
  // back a new booking answers the agent, not an older reminder.
  const template = await withTenant(deps.db, input.business.id, (tx) =>
    lastOutboundMessage(
      tx,
      input.conversation.id,
      new Date(input.now.getTime() - TYPED_REPLY_WINDOW_MS),
    ),
  );
  if (template?.type !== "template") return null;
  const buttons = Array.isArray(template.payload.buttons)
    ? (template.payload.buttons as { text?: unknown; payload?: unknown }[])
    : [];
  const hit = buttons.find((b) => typeof b.text === "string" && normalize(b.text) === typed);
  const payload = typeof hit?.payload === "string" ? decodeButtonPayload(hit.payload) : null;
  return payload ? { payload, text: String(hit?.text), messageId: last.id } : null;
}

async function handleTap(deps: AutomationDeps, input: ButtonInput, tap: Tap) {
  const { business, prepared, contact, conversation, now } = input;
  const found = await withTenant(deps.db, business.id, async (tx) => {
    const run = await getRun(tx, tap.payload.runId);
    const automation = run ? await getAutomation(tx, run.automationId) : null;
    if (!run || automation?.ruleKey !== tap.payload.ruleKey) return null;
    const booking = run.subjectType === "booking" ? await getBooking(tx, run.subjectId) : null;
    // The tap must come from the person the message was about.
    const owner =
      booking?.contactId ??
      (run.subjectType === "contact"
        ? run.subjectId
        : run.subjectType === "conversation"
          ? (await getConversation(tx, run.subjectId))?.contactId
          : null);
    return owner === contact.id ? { run, booking } : null;
  });
  const rule = found ? findRule(prepared.template, tap.payload.ruleKey) : null;
  const actions = rule?.on_button?.[tap.payload.payload];
  if (!found || !rule || !actions) return null;
  const { run, booking } = found;
  const human = conversation.mode === "human";
  const log = deps.logger.child({ business_id: business.id, run_id: run.id, rule: rule.key });

  if (booking && outdated(run, booking, rule.trigger.type)) {
    log.info({ button: tap.payload.payload }, "button tap on an outdated message");
    return {
      replies: [],
      agentNote: human
        ? null
        : `The customer tapped "${tap.text}" on an earlier automatic message about a booking that has since ` +
          `been moved or has ended (now: ${describe(booking, business.timezone)}). Don't act on the tap; ` +
          "help them with what they need.",
    };
  }

  const context = await withTenant(deps.db, business.id, (tx) =>
    automationContext(tx, { business, prepared, contact, booking, now }),
  );
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
  const replies: Reply[] = [];
  let agentNote: string | null = null;
  for (const [i, action] of actions.entries()) {
    const { type, ...params } = action;
    const key = `button:${tap.messageId}:${i}`;
    if (type === "update_booking") await updateBookingAction(deps, target, params);
    else if (type === "update_contact") await updateContactAction(deps, target, params);
    else if (type === "notify_staff") await notifyStaffAction(deps, target, params, key, "button");
    else if (human)
      continue; // decision A12: say nothing during a handoff
    else if (type === "send_text") {
      replies.push({ body: renderText(String(params.text), context), meta: { kind: "fixed" } });
    } else if (type === "send_template") {
      await sendTemplateAction(deps, target, String(params.template), key);
    } else if (type === "start_agent") {
      agentNote = startAgentNote(String(params.intent), tap, booking, business.timezone);
    }
  }
  if (human) {
    const who = contact.name ?? booking?.subjectName ?? contact.waNumber;
    await withTenant(deps.db, business.id, (tx) =>
      notifyStaff(tx, {
        businessId: business.id,
        kind: "button",
        // Staff-facing text (Spanish UI label, like the admin's).
        text: `${who} tocó «${tap.text}» en un mensaje automático mientras la conversación está con el equipo.`,
        payload: { ...links(target), button: tap.payload.payload },
        dedupeKey: `button:${tap.messageId}`,
      }),
    );
  }
  log.info({ button: tap.payload.payload, handoff_open: human }, "button reply handled");
  return { replies, agentNote };
}

/** The booking moved or ended since a message about it went out. */
function outdated(run: AutomationRunRow, booking: BookingRow, trigger: string): boolean {
  if (booking.status !== "pending" && booking.status !== "confirmed") return true;
  return trigger === "booking.starts_in" && booking.startsAt.toISOString() !== run.occurrenceKey;
}

function describe(booking: BookingRow, zone: string): string {
  const label = formatSlotLabel(DateTime.fromJSDate(booking.startsAt, { zone }));
  return `${booking.serviceName}, ${label}, status ${booking.status}, booking_id ${booking.id}`;
}

/** Runtime note for the agent (English, model-only) when a tap hands it the conversation. */
function startAgentNote(
  intent: string,
  tap: Tap,
  booking: BookingRow | null,
  zone: string,
): string {
  const about = booking ? ` about booking ${describe(booking, zone)}` : "";
  const goal =
    intent === "reschedule"
      ? "They want to move it: find new times with check_availability and use reschedule with that booking_id."
      : intent === "cancel"
        ? "They want to cancel it: confirm which booking and use cancel with that booking_id."
        : intent === "book"
          ? "They want to book an appointment."
          : "Help them with what they need.";
  return `The customer tapped "${tap.text}" on an automatic message${about}. ${goal}`;
}
