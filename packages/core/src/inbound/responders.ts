import type { Responder } from "./process.ts";

/** Stores and acknowledges messages without replying (until the agent arrives in M3). */
export const silentResponder: Responder = () => Promise.resolve([]);

/**
 * M2 test harness (INBOUND_HANDLER=echo): one reply repeating what the batch said. Not
 * patient-facing, so it isn't template text; never enable it for a real business.
 */
export const echoResponder: Responder = (batch) => {
  // Principle 7: while a person handles the conversation, the bot stays silent.
  if (batch.conversation.mode === "human") return Promise.resolve([]);
  const parts = batch.messages.map((m) => m.body ?? `[${m.type}]`);
  return Promise.resolve([{ body: `echo: ${parts.join(" / ")}`, meta: { kind: "echo" } }]);
};
