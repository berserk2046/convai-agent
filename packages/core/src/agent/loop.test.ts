import { scriptedLlm } from "@platform/llm/testing";
import { describe, expect, it } from "vitest";
import { rewrite, type ModelRequest } from "./loop.ts";

/** The price-guard retry must not edit what a thinking model already saw (ADR 0017). */

const transcript = [{ role: "user" as const, content: "¿Cuánto vale la limpieza?" }];

function request(model: string): ModelRequest {
  return {
    model,
    system: [{ type: "text", text: "Eres el asistente." }],
    messages: transcript,
    tools: [],
  };
}

describe("price-guard rewrite", () => {
  it("appends the note as a system message on a model that thinks by default", async () => {
    const llm = scriptedLlm([{ text: "Cuesta $120.000." }]);
    expect(await rewrite(llm, request("claude-haiku-5-5"), transcript, "Fix the price.")).toBe(
      "Cuesta $120.000.",
    );
    const sent = llm.requests[0];
    expect(sent?.system).toEqual([{ type: "text", text: "Eres el asistente." }]);
    expect(sent?.messages).toEqual([...transcript, { role: "system", content: "Fix the price." }]);
    expect(sent?.tool_choice).toEqual({ type: "none" });
  });

  it("adds the note to the system prompt on older models", async () => {
    const llm = scriptedLlm([{ text: "Cuesta $120.000." }]);
    await rewrite(llm, request("claude-haiku-4-5-20251001"), transcript, "Fix the price.");
    const sent = llm.requests[0];
    expect(sent?.system).toEqual([
      { type: "text", text: "Eres el asistente." },
      { type: "text", text: "Fix the price." },
    ]);
    expect(sent?.messages).toEqual(transcript);
  });
});
