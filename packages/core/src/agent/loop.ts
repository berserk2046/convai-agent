import type { Anthropic, LlmClient } from "@platform/llm";
import type { ToolOutcome } from "./tools/types.ts";

/**
 * The model ↔ tools loop (spec §7.5), written by hand rather than with the SDK's beta tool
 * runner: we need to validate and scope every call ourselves, cap the number of calls,
 * stop on a handoff, and re-ask with tools switched off for the price guard.
 */

export interface ModelRequest {
  model: string;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface ToolCallLog {
  name: string;
  input: unknown;
  result: Record<string, unknown>;
  isError: boolean;
}

export interface ModelRun {
  /** The final reply text ("" when the model only called tools). */
  text: string;
  handoff: { reason: string } | null;
  /** True when the turn hit max_tool_calls_per_turn (spec: hand off with reason "error"). */
  exceededToolCalls: boolean;
  refused: boolean;
  toolCalls: ToolCallLog[];
  /** The conversation up to (not including) the final text, for a price-guard rewrite. */
  transcript: Anthropic.MessageParam[];
}

/** Replies are a few sentences; this only bounds runaway output. */
const MAX_TOKENS = 1024;

export async function runModel(
  llm: LlmClient,
  request: ModelRequest,
  execute: (name: string, input: unknown) => Promise<ToolOutcome>,
  maxToolCalls: number,
): Promise<ModelRun> {
  const messages = [...request.messages];
  const toolCalls: ToolCallLog[] = [];
  for (;;) {
    const response = await llm.createMessage({ ...request, messages, max_tokens: MAX_TOKENS });
    const text = textOf(response);
    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const base = { toolCalls, transcript: messages };

    if (response.stop_reason === "refusal")
      return { ...base, text: "", handoff: null, exceededToolCalls: false, refused: true };
    if (response.stop_reason !== "tool_use" || uses.length === 0) {
      return { ...base, text, handoff: null, exceededToolCalls: false, refused: false };
    }
    if (toolCalls.length + uses.length > maxToolCalls) {
      return { ...base, text: "", handoff: null, exceededToolCalls: true, refused: false };
    }

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    let handoff: { reason: string } | null = null;
    // All results of one response go back in a single user message.
    for (const use of uses) {
      const outcome = await execute(use.name, use.input);
      toolCalls.push({
        name: use.name,
        input: use.input,
        result: outcome.result,
        isError: outcome.isError === true,
      });
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(outcome.result),
        ...(outcome.isError ? { is_error: true } : {}),
      });
      handoff ??= outcome.handoff ?? null;
    }
    messages.push({ role: "user", content: results });
    if (handoff) return { ...base, text, handoff, exceededToolCalls: false, refused: false };
  }
}

/**
 * Price-guard retry (spec §7.6): the same conversation, a corrective system note, tools
 * listed (the history has tool blocks) but not callable.
 */
export async function rewrite(
  llm: LlmClient,
  request: ModelRequest,
  transcript: Anthropic.MessageParam[],
  note: string,
): Promise<string> {
  const response = await llm.createMessage({
    ...request,
    system: [...request.system, { type: "text", text: note }],
    messages: transcript,
    tool_choice: { type: "none" },
    max_tokens: MAX_TOKENS,
  });
  return response.stop_reason === "refusal" ? "" : textOf(response);
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
