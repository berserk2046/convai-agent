import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { NO_USAGE, addUsage, costUsd, isKnownModel, usageOf, type TokenUsage } from "./pricing.ts";

/**
 * The one door to the Anthropic Messages API. The agent only depends on `LlmClient`, so
 * tests and eval replay can swap in a scripted client (./testing.ts).
 */

export interface LlmClient {
  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface AnthropicLlmOptions {
  apiKey: string;
  /** SDK retries 408/409/429/5xx and connection errors with backoff (default 2). */
  maxRetries?: number;
  timeoutMs?: number;
}

export function createAnthropicLlm(options: AnthropicLlmOptions): LlmClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? 60_000,
  });
  return { createMessage: (params) => client.messages.create(params) };
}

export interface MeteredLlm extends LlmClient {
  /** Tokens of every response so far. */
  readonly usage: TokenUsage;
  /** USD of every response so far, priced request by request (models without a price add 0). */
  readonly costUsd: number;
}

/**
 * Adds up the usage and cost of every response, so spend is recorded even when a turn
 * fails after some calls succeeded (principle 10). Callers refuse unpriced models first.
 */
export function meteredLlm(llm: LlmClient): MeteredLlm {
  let usage = NO_USAGE;
  let cost = 0;
  return {
    get usage() {
      return usage;
    },
    get costUsd() {
      return cost;
    },
    async createMessage(params) {
      const response = await llm.createMessage(params);
      const used = usageOf(response);
      usage = addUsage(usage, used);
      if (isKnownModel(params.model)) cost += costUsd(params.model, used);
      return response;
    },
  };
}

/**
 * Whether a failed call is worth retrying later (rate limits, overload, 5xx, network) as
 * opposed to a request we built wrong or bad credentials. Checked most specific first:
 * in the TypeScript SDK, APIConnectionError is a subclass of APIError.
 */
export function isRetryableLlmError(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIError)
    return error.status === 529 || error.status === 408 || error.status === 409;
  return false;
}

/** Zod schema → the `input_schema` of an Anthropic tool definition. */
export function toolInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  if (json.type !== "object") throw new Error("tool input schemas must be objects");
  return json as Anthropic.Tool.InputSchema;
}

export type { Anthropic };
