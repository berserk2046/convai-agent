import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isRetryableLlmError, meteredLlm, toolInputSchema } from "./client.ts";
import { addUsage, costUsd, isKnownModel, usageOf } from "./pricing.ts";
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
  });
});
