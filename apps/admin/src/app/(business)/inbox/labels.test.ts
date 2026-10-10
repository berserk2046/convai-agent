import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SYSTEM_SUMMARIES, reasonLabel, summaryText } from "./labels.ts";

describe("handoff labels", () => {
  it("prefers the template's name, then names the runtime's reasons, then humanizes", () => {
    expect(reasonLabel("pide_humano", "Pide hablar con una persona")).toBe(
      "Pide hablar con una persona",
    );
    expect(reasonLabel("price_guard")).toBe("Precio por confirmar");
    expect(reasonLabel("price_guard", null)).toBe("Precio por confirmar");
    expect(reasonLabel("pide_humano")).toBe("Pide humano");
  });

  it("translates every fixed summary the responder writes", () => {
    // The responder's summaries are string literals; a new one needs a Spanish text here.
    const source = readFileSync(
      new URL("../../../../../../packages/core/src/agent/responder.ts", import.meta.url),
      "utf8",
    );
    const calls = [...source.matchAll(/await handOff\(([\s\S]*?)\);/g)].map((m) => m[1] ?? "");
    const literals = [
      ...calls.flatMap((call) =>
        [...call.matchAll(/"([^"]*)"/g)]
          .map((m) => m[1] ?? "")
          .filter((text) => text.includes(" ")),
      ),
      ...[...source.matchAll(/summary: "([^"]+)"/g)].map((m) => m[1] ?? ""),
    ];
    expect(literals.length).toBeGreaterThanOrEqual(8);
    for (const text of literals) expect(SYSTEM_SUMMARIES).toHaveProperty([text]);
  });

  it("keeps the model's own summaries as written", () => {
    expect(summaryText("Quiere saber si atienden niños")).toBe("Quiere saber si atienden niños");
    expect(summaryText(null)).toBeNull();
  });
});
