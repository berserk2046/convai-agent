import type { MessageRow } from "@platform/db";
import type { Anthropic } from "@platform/llm";

/**
 * Conversation history for the model (spec §7.4): stored messages become alternating
 * user/assistant turns, with this batch as the final user turn. Text only: tool calls of
 * earlier turns aren't replayed (state the model needs, such as bookings and pending
 * proposals, comes from the dynamic context instead).
 */

export interface History {
  messages: Anthropic.MessageParam[];
  /** Business messages before the person's first one (e.g. a reminder), for context. */
  openingNote: string | null;
}

export function buildHistory(recent: readonly MessageRow[], batch: readonly MessageRow[]): History {
  const batchIds = new Set(batch.map((m) => m.id));
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const message of recent) {
    if (batchIds.has(message.id)) continue;
    const text = textOf(message);
    if (text) turns.push({ role: message.direction === "inbound" ? "user" : "assistant", text });
  }

  // The API needs the first message to be the user's.
  const opening: string[] = [];
  while (turns[0]?.role === "assistant") opening.push(turns.shift()?.text ?? "");

  turns.push({ role: "user", text: batch.map(textOf).filter(Boolean).join("\n") });
  return { messages: merge(turns), openingNote: opening.length > 0 ? opening.join("\n") : null };
}

/** What a message said; non-text messages become a marker like "[audio]". */
export function textOf(message: MessageRow): string {
  if (message.body !== null && message.body.trim() !== "") return message.body.trim();
  return message.direction === "inbound" ? `[${message.type}]` : "";
}

function merge(turns: { role: "user" | "assistant"; text: string }[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    const last = out.at(-1);
    if (last && last.role === turn.role && typeof last.content === "string") {
      last.content = `${last.content}\n${turn.text}`;
    } else {
      out.push({ role: turn.role, content: turn.text });
    }
  }
  return out;
}
