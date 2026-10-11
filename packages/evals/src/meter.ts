import {
  NO_USAGE,
  addUsage,
  costUsd,
  isKnownModel,
  usageOf,
  type LlmClient,
  type TokenUsage,
} from "@platform/llm";

/**
 * Counts what each LLM call used and cost, and remembers failures. The agent turns a
 * failed call into a handoff (the customer must get an answer), so without this an API
 * outage or a replay miss would look like the agent's own mistake in an eval report.
 */

export interface MeteredCalls extends LlmClient {
  /** Tokens of every response. */
  usage(): TokenUsage;
  /** USD actually spent: zero when replaying recorded responses. */
  costUsd(): number;
  /** Models that answered, in call order (deduplicated). */
  models(): string[];
  /** Errors thrown by calls, oldest first. */
  readonly errors: unknown[];
}

export function meterCalls(llm: LlmClient, options: { billable: boolean }): MeteredCalls {
  let usage = NO_USAGE;
  let cost = 0;
  const models: string[] = [];
  const errors: unknown[] = [];
  return {
    errors,
    usage: () => usage,
    costUsd: () => cost,
    models: () => [...models],
    async createMessage(params) {
      try {
        const response = await llm.createMessage(params);
        const used = usageOf(response);
        usage = addUsage(usage, used);
        if (options.billable && isKnownModel(params.model)) cost += costUsd(params.model, used);
        if (!models.includes(params.model)) models.push(params.model);
        return response;
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  };
}
