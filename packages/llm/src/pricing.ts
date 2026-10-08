import type Anthropic from "@anthropic-ai/sdk";

/**
 * LLM cost accounting (spec §7.8, principle 10). Prices in USD per million tokens, from
 * Anthropic's published pricing (claude-api reference, cached 2026-09-25). Cache writes
 * (5-minute TTL) cost 1.25× input and cache reads 0.1× input. Cost reports use what the
 * API actually reported, never assumed cache savings.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const HAIKU_4_5: ModelPrice = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
const SONNET_5_5: ModelPrice = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-haiku-4-5": HAIKU_4_5,
  "claude-haiku-4-5-20251001": HAIKU_4_5,
  "claude-sonnet-5-5": SONNET_5_5,
};

export function isKnownModel(model: string): boolean {
  return Object.hasOwn(MODEL_PRICES, model);
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

/** Throws for a model without a price, so spend is never silently uncounted. */
export function costUsd(model: string, usage: TokenUsage): number {
  const price = isKnownModel(model) ? MODEL_PRICES[model] : undefined;
  if (!price) throw new Error(`no price for model "${model}"; add it to MODEL_PRICES`);
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheWrite * price.cacheWrite +
      usage.cacheRead * price.cacheRead) /
    1_000_000
  );
}
