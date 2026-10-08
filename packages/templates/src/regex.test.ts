import { describe, expect, it } from "vitest";
import { checkTemplateRegex, compileTemplateRegex } from "./regex.ts";

describe("checkTemplateRegex", () => {
  it.each([
    "^\\s*s[ií](?![a-zñáéíóú])",
    "\\bacepto",
    "hinchaz[oó]n",
    "(part|romp)[a-záéíóúñ]*\\s+(un|el)\\s+(dientes?|muelas?)",
    "\\d{1,3}(\\.\\d{3})+",
  ])("accepts %s", (source) => {
    expect(checkTemplateRegex(source)).toBeNull();
  });

  it.each([
    ["s[ií]\\b", "class with í before \\b"],
    ["sí\\b", "literal í before \\b"],
    ["\\bárbol", "literal á after \\b"],
    ["[ií]+\\b", "quantified class before \\b"],
    ["dolor\\s+fuerte|ñ\\B", "\\B counts too"],
  ])("rejects %s (%s)", (source) => {
    expect(checkTemplateRegex(source)).toMatch(/ASCII-only/);
  });

  it("rejects patterns that only compile without the u flag", () => {
    expect(checkTemplateRegex("\\-")).toMatch(/does not compile/);
    expect(checkTemplateRegex("(abc")).toMatch(/does not compile/);
  });
});

describe("compileTemplateRegex", () => {
  it("is case-insensitive and Unicode-aware", () => {
    const accept = compileTemplateRegex("^\\s*s[ií](?![a-zñáéíóú])");
    expect(accept.test("Sí")).toBe(true);
    expect(accept.test("SI, claro")).toBe(true);
    expect(accept.test("sin problema")).toBe(false);
  });

  it("shows why \\b next to accents is a trap", () => {
    expect(new RegExp("s[ií]\\b", "iu").test("sí")).toBe(false);
  });
});
