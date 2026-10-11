import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isRetryableLlmError, meteredLlm, toolInputSchema } from "./client.ts";
import { addUsage, costUsd, isKnownModel, thinksAdaptively, usageOf } from "./pricing.ts";
import { message, scriptedLlm, transientLlmError } from "./testing.ts";

describe("costUsd", () => {
  it("prices Haiku 4.5 per million tokens, cache reads at a tenth", () => {
    const usage = { input: 3000, output: 200, cacheRead: 4000, cacheWrite: 0 };
    // 3000×$1 + 200×$5 + 4000×$0.10, per million
    expect(costUsd("claude-haiku-4-5-20251001", usage)).toBeCloseTo(0.0044, 8);
  });

  it("charges cache writes at 1.25× input", () => {
    expect(
      costUsd("claude-haiku-4-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }),
    ).toBe(1.25);
  });

  it("prices Haiku 5.5 on its two rate cards, by each request's whole prompt", () => {
    const short = { input: 4000, output: 400, cacheRead: 0, cacheWrite: 0 };
    // 4000×$0.10 + 400×$0.50, per million
    expect(costUsd("claude-haiku-5-5", short)).toBeCloseTo(0.0006, 10);
    const cached = { input: 1000, output: 0, cacheRead: 3000, cacheWrite: 0 };
    expect(costUsd("claude-haiku-5-5", cached)).toBeCloseTo(0.00013, 10);
    // Over 100,000 prompt tokens, cache reads included, the whole request is on the higher card.
    const long = { input: 1000, output: 1000, cacheRead: 100_000, cacheWrite: 0 };
    expect(costUsd("claude-haiku-5-5", long)).toBeCloseTo(
      (1000 * 0.5 + 1000 * 2.5 + 100_000 * 0.05) / 1_000_000,
      10,
    );
  });

  it("prices Sonnet 5.5 cache reads at 0.05× input", () => {
    const usage = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 };
    expect(costUsd("claude-sonnet-5-5", usage)).toBeCloseTo(0.1, 10);
  });

  it("knows which models think by default", () => {
    expect(thinksAdaptively("claude-haiku-5-5")).toBe(true);
    expect(thinksAdaptively("claude-sonnet-5-5")).toBe(true);
    expect(thinksAdaptively("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("refuses to guess a price", () => {
    expect(() =>
      costUsd("claude-unknown", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
    ).toThrow(/no price/);
    // Object prototype keys are not models.
    expect(isKnownModel("constructor")).toBe(false);
  });

  it("reads usage from a response, treating missing cache fields as 0", () => {
    const usage = usageOf(
      message("claude-haiku-4-5", [], "end_turn", {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: null,
      }),
    );
    expect(addUsage(usage, usage)).toEqual({ input: 20, output: 4, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("toolInputSchema", () => {
  it("turns a strict Zod object into an Anthropic input_schema", () => {
    const schema = toolInputSchema(
      z.strictObject({
        service_key: z.string().describe("Catalog key"),
        party_size: z.number().int().min(1).optional(),
      }),
    );
    expect(schema).toEqual({
      type: "object",
      properties: {
        service_key: { type: "string", description: "Catalog key" },
        party_size: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ["service_key"],
      additionalProperties: false,
    });
  });
});

describe("isRetryableLlmError", () => {
  it("retries network failures but not our own bugs", () => {
    expect(
      isRetryableLlmError(new Anthropic.APIConnectionError({ message: "socket hang up" })),
    ).toBe(true);
    expect(isRetryableLlmError(new TypeError("x is undefined"))).toBe(false);
  });
});

describe("scriptedLlm", () => {
  it("returns scripted tool calls and text, recording requests", async () => {
    const llm = scriptedLlm([
      { tools: [{ name: "lookup_catalog", input: { key: "limpieza" } }] },
      { text: "Cuesta $120.000." },
    ]);
    const params = {
      model: "claude-haiku-4-5",
      max_tokens: 100,
      messages: [{ role: "user" as const, content: "¿Precio?" }],
    };
    const first = await llm.createMessage(params);
    expect(first.stop_reason).toBe("tool_use");
    expect(first.content[0]).toMatchObject({
      type: "tool_use",
      name: "lookup_catalog",
      input: { key: "limpieza" },
    });
    const second = await llm.createMessage(params);
    expect(second.content).toEqual([{ type: "text", text: "Cuesta $120.000.", citations: null }]);
    expect(llm.requests).toHaveLength(2);
    expect(llm.remaining()).toBe(0);
    await expect(llm.createMessage(params)).rejects.toThrow(/no more steps/);
  });
});

describe("meteredLlm", () => {
  it("adds up usage across calls and keeps it when a later call fails", async () => {
    const llm = meteredLlm(
      scriptedLlm([
        { text: "uno" },
        { text: "dos" },
        () => {
          throw transientLlmError();
        },
      ]),
    );
    const params = {
      model: "claude-haiku-4-5",
      max_tokens: 100,
      messages: [{ role: "user" as const, content: "Hola" }],
    };
    await llm.createMessage(params);
    await llm.createMessage(params);
    await expect(llm.createMessage(params)).rejects.toThrow(/Connection error/);
    expect(llm.usage).toEqual({ input: 2000, output: 100, cacheRead: 0, cacheWrite: 0 });
    // 2 × (1000×$1 + 50×$5) per million on Haiku 4.5
    expect(llm.costUsd).toBeCloseTo(0.0025, 10);
  });

  it("prices each request on its own (Haiku 5.5's long-prompt card is per request)", async () => {
    const llm = meteredLlm(
      scriptedLlm([{ text: "uno" }, { text: "dos" }], { input_tokens: 60_000, output_tokens: 0 }),
    );
    const params = {
      model: "claude-haiku-5-5",
      max_tokens: 100,
      messages: [{ role: "user" as const, content: "Hola" }],
    };
    await llm.createMessage(params);
    await llm.createMessage(params);
    // 120,000 tokens in total, but each request is under 100,000: the short card applies.
    expect(llm.costUsd).toBeCloseTo((2 * 60_000 * 0.1) / 1_000_000, 10);
  });
});
