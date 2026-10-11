import type Anthropic from "@anthropic-ai/sdk";

/**
 * LLM cost accounting (spec §7.8, principle 10). Prices in USD per million tokens, from
 * Anthropic's pricing page (fetched 2026-10-10). Cache writes are the 5-minute TTL kind.
 * Cost reports use what the API actually reported, never assumed cache savings.
 *
 * `costUsd` prices **one request**: sum per-request costs, never price summed usage, since
 * Claude Haiku 5.5's rate card depends on each request's prompt length.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const HAIKU_4_5: ModelPrice = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
const HAIKU_5_5: ModelPrice = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 };
// Cache reads on Sonnet 5.5 are 0.05× input.
const SONNET_5_5: ModelPrice = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };

/** Prices for prompts up to each model's long-prompt threshold (if it has one). */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-4-5": HAIKU_4_5,
  "claude-haiku-4-5-20251001": HAIKU_4_5,
  "claude-haiku-5-5": HAIKU_5_5,
  "claude-sonnet-5-5": SONNET_5_5,
};

/**
 * Claude Haiku 5.5 bills a request whose prompt is over 100,000 tokens (input plus cache
 * reads and writes) entirely at higher prices.
 */
const LONG_PROMPT_PRICES: Readonly<Record<string, { overTokens: number; price: ModelPrice }>> = {
  "claude-haiku-5-5": {
    overTokens: 100_000,
    price: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  },
};

export function isKnownModel(model: string): boolean {
  return Object.hasOwn(MODEL_PRICES, model);
}

/**
 * Models that think by default (adaptive thinking). They take `output_config.effort`,
 * accept mid-conversation `role: "system"` messages, count thinking against `max_tokens`,
 * and reject a request that changes anything before a thinking block it sends back
 * (Anthropic's migration guide, "preserved thinking"). Check this for every model added
 * to MODEL_PRICES.
 */
const ADAPTIVE_THINKING: ReadonlySet<string> = new Set(["claude-haiku-5-5", "claude-sonnet-5-5"]);

export function thinksAdaptively(model: string): boolean {
  return ADAPTIVE_THINKING.has(model);
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function usageOf(message: Pick<Anthropic.Message, "usage">): TokenUsage {
  const u = message.usage;
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** One request's cost. Throws for a model without a price, so spend is never silently uncounted. */
export function costUsd(model: string, usage: TokenUsage): number {
  const standard = isKnownModel(model) ? MODEL_PRICES[model] : undefined;
  if (!standard) throw new Error(`no price for model "${model}"; add it to MODEL_PRICES`);
  const long = Object.hasOwn(LONG_PROMPT_PRICES, model) ? LONG_PROMPT_PRICES[model] : undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const price = long && prompt > long.overTokens ? long.price : standard;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheWrite * price.cacheWrite +
      usage.cacheRead * price.cacheRead) /
    1_000_000
  );
}
