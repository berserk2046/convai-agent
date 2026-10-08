import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "./client.ts";

/**
 * A scripted stand-in for Claude: each call returns the next scripted reply. Lets the
 * agent loop be tested without an API key; eval replay (M6) builds on the same idea.
 */

export type ScriptStep =
  | { text: string }
  | { tools: { name: string; input: Record<string, unknown> }[]; text?: string }
  | ((request: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message);

export interface ScriptedLlm extends LlmClient {
  requests: Anthropic.MessageCreateParamsNonStreaming[];
  /** Steps not used yet; a test can assert the script ran to the end. */
  remaining(): number;
}

let counter = 0;

export function scriptedLlm(
  steps: ScriptStep[],
  usage: Partial<Anthropic.Usage> = {},
): ScriptedLlm {
  const queue = [...steps];
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    remaining: () => queue.length,
    createMessage(params) {
      requests.push(structuredClone(params));
      const step = queue.shift();
      if (!step) return Promise.reject(new Error("scripted LLM: no more steps"));
      if (typeof step === "function") return Promise.resolve(step(params));
      const content: Anthropic.ContentBlock[] = [];
      if ("tools" in step) {
        if (step.text) content.push(textBlock(step.text));
        for (const tool of step.tools) {
          counter += 1;
          content.push({
            type: "tool_use",
            id: `toolu_${String(counter)}`,
            name: tool.name,
            input: tool.input,
            caller: { type: "direct" },
          });
        }
      } else {
        content.push(textBlock(step.text));
      }
      return Promise.resolve(
        message(params.model, content, "tools" in step ? "tool_use" : "end_turn", usage),
      );
    },
  };
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

export function message(
  model: string,
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason,
  usage: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  counter += 1;
  return {
    id: `msg_${String(counter)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    },
  } as Anthropic.Message;
}

/** A network failure as the SDK reports it: retryable. */
export function transientLlmError(): Error {
  return new Anthropic.APIConnectionError({ message: "Connection error." });
}
