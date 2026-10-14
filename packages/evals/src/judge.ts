import { thinksAdaptively, type Anthropic, type LlmClient } from "@platform/llm";
import { z } from "zod";
import type { AssertionResult, ObservedTurn } from "./assertions.ts";
import type { SandboxState } from "./sandbox.ts";

/**
 * The `judge` assertion (spec §11): a second model (JUDGE_MODEL, Claude Sonnet) reads the
 * conversation and the template's rubric and returns pass or fail with a reason. The
 * verdict comes back as structured output (`output_config.format`): Sonnet 5.5 rejects a
 * forced tool_choice, and the JSON schema guarantees a parseable answer. Grading a short
 * rubric is a classification task, so models that think by default run at low effort
 * (ADR 0017).
 */

/**
 * `reason` comes first on purpose: structured output writes keys in schema order, and a
 * model that writes the verdict before its reasoning can contradict itself (it happened
 * on the first live runs, ADR 0018).
 */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description:
        "Check each point of the rubric against the conversation, in one to three sentences.",
    },
    pass: { type: "boolean", description: "True only if the reason found that every point holds." },
  },
  required: ["reason", "pass"],
  additionalProperties: false,
};

const verdict = z.object({ pass: z.boolean(), reason: z.string() });

const SYSTEM =
  "You grade conversations between a business's WhatsApp assistant and a customer, for an " +
  "automated test suite. You get the conversation and a rubric. Judge only what the " +
  "assistant wrote and did, strictly against the rubric: pass only if every point of the " +
  "rubric holds. Write your reasoning first, then a verdict that agrees with it. The " +
  "conversation is in Spanish; write your reason in English.";

/** Room for the model's thinking plus a short verdict. */
const MAX_TOKENS = 8_000;

export function judgeRequest(
  model: string,
  rubric: string,
  turns: readonly ObservedTurn[],
  state: SandboxState,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `<conversation>\n${transcriptText(turns, state)}\n</conversation>\n\n` +
          `<rubric>\n${rubric}\n</rubric>`,
      },
    ],
    output_config: {
      format: { type: "json_schema", schema: VERDICT_SCHEMA },
      ...(thinksAdaptively(model) ? { effort: "low" as const } : {}),
    },
  };
}

export async function judge(
  llm: LlmClient,
  model: string,
  rubric: string,
  turns: readonly ObservedTurn[],
  state: SandboxState,
): Promise<AssertionResult> {
  const response = await llm.createMessage(judgeRequest(model, rubric, turns, state));
  if (response.stop_reason === "refusal") {
    return { name: "judge", passed: false, detail: "the judge model declined to grade" };
  }
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = verdict.safeParse(parseJson(text));
  if (!parsed.success) {
    const why = response.stop_reason === "max_tokens" ? " (it ran out of tokens)" : "";
    return { name: "judge", passed: false, detail: `the judge gave no usable verdict${why}` };
  }
  return { name: "judge", passed: parsed.data.pass, detail: parsed.data.reason };
}

/** The conversation as the judge reads it: messages, plus the actions the assistant took. */
export function transcriptText(turns: readonly ObservedTurn[], state: SandboxState): string {
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(`Customer: ${turn.user}`);
    const tools = turn.toolCalls.map((c) => c.name);
    if (tools.length > 0) lines.push(`[assistant used tools: ${tools.join(", ")}]`);
    for (const reply of turn.replies) lines.push(`Assistant: ${reply.body}`);
  }
  const open = state.handoffs.filter((h) => h.open);
  if (open.length > 0) {
    lines.push(`[the conversation was handed to staff: ${open.map((h) => h.reason).join(", ")}]`);
  }
  return lines.join("\n");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
