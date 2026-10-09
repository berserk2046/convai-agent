import type { BusinessRow, ContactRow, ConversationRow, MessageRow } from "@platform/db";
import type { PreparedTemplate } from "@platform/templates";
import type { Reply } from "../inbound/process.ts";

/**
 * The hook for template button replies (spec §9). The automations package implements it;
 * the agent calls it after the emergency and opt-out checks and before the human-mode
 * check, so a tap during a handoff still updates data (decision A12).
 */

export interface ButtonInput {
  business: BusinessRow;
  prepared: PreparedTemplate;
  conversation: ConversationRow;
  contact: ContactRow;
  /** The batch, oldest first. */
  messages: readonly MessageRow[];
  /** The batch's text, joined: a typed "Confirmo" counts as a tap (decision A11). */
  text: string;
  now: Date;
}

export interface ButtonOutcome {
  /** Fixed replies for the customer (template text). */
  replies: Reply[];
  /** Set when the tap hands the conversation to the agent (start_agent): a note for it. */
  agentNote: string | null;
}

/** Null when the batch isn't a button tap the template handles: the agent answers it. */
export type ButtonHandler = (input: ButtonInput) => Promise<ButtonOutcome | null>;
