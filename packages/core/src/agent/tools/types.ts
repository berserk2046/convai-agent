import type { BusinessRow, ContactRow, ConversationRow, Database } from "@platform/db";
import type { SchedulingProvider } from "@platform/scheduling";
import type { Logger } from "@platform/shared";
import type { BookingRules, PreparedTemplate, ToolName } from "@platform/templates";
import type { z } from "zod";

/** Booking lifecycle events. M4's automations engine consumes them; until then they're logged. */
export interface BookingEvent {
  type: "booking.created" | "booking.rescheduled" | "booking.cancelled" | "booking.completed";
  businessId: string;
  bookingId: string;
  at: Date;
}

export interface EventSink {
  emit(event: BookingEvent): Promise<void>;
}

/** Everything a tool may touch for one agent turn. Always scoped to one business. */
export interface ToolContext {
  db: Database;
  logger: Logger;
  business: BusinessRow;
  config: Record<string, unknown>;
  prepared: PreparedTemplate;
  timezone: string;
  /** Resolved booking rules (`_config` applied); null if the template doesn't book. */
  rules: BookingRules | null;
  conversation: ConversationRow;
  contact: ContactRow;
  /** Mutable: becomes true when the customer accepts consent during this turn. */
  consentGiven: boolean;
  /** This turn (the batch's last inbound message id); confirmations must come in a later one. */
  turnId: string;
  /**
   * Every message of this batch. A retried batch can include messages of an attempt that
   * failed, so a proposal made then was never shown and doesn't count as earlier (A5).
   */
  batchMessageIds: ReadonlySet<string>;
  now: Date;
  provider: SchedulingProvider;
  events: EventSink;
}

/** A tool result goes back to the model as JSON; `isError` marks it as a failed call. */
export interface ToolOutcome {
  result: Record<string, unknown>;
  isError?: boolean;
  /** Ends the turn after this call (handoff). */
  handoff?: { reason: string };
}

export interface AgentTool {
  name: ToolName;
  /** For the model: when to use the tool and what it returns. */
  description: string;
  /** Model-visible input; may depend on the template (e.g. allowed handoff reasons). */
  input(ctx: ToolContext): z.ZodType;
  run(
    ctx: ToolContext,
    input: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Promise<ToolOutcome>;
}

export function toolError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolOutcome {
  return { result: { error: code, message, ...extra }, isError: true };
}
