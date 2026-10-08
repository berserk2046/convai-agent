import { describe, expect, it } from "vitest";
import { TemplateRenderer } from "./liquid.ts";

const renderer = new TemplateRenderer();
const render = (source: string, context: Record<string, unknown> = {}) =>
  renderer.render(source, context);

describe("platform filters (Appendix B)", () => {
  it("cop formats Colombian pesos", () => {
    expect(render("${{ p | cop }}", { p: 120000 })).toBe("$120.000");
    expect(render("{{ p | cop }}", { p: null })).toBe("");
  });

  it("date formats in the business timezone", () => {
    const context = { business: { timezone: "America/Bogota" }, at: "2026-10-08T20:00:00Z" };
    expect(render('{{ at | date: "yyyy-MM-dd HH:mm" }}', context)).toBe("2026-10-08 15:00");
  });

  it("keeps join, default, upcase and downcase", () => {
    expect(render('{{ xs | join: ", " }}', { xs: ["a", "b"] })).toBe("a, b");
    expect(render('{{ missing | default: "x" }}')).toBe("x");
    expect(render("{{ s | upcase }}-{{ s | downcase }}", { s: "Sí" })).toBe("SÍ-sí");
  });

  it.each(["escape", "size", "append", "jsonify", "url_encode", "sha256"])(
    "removes the built-in %s filter",
    (filter) => {
      expect(() => render(`{{ s | ${filter} }}`, { s: "x" })).toThrow(/undefined filter/);
    },
  );
});

describe("strictness", () => {
  it("fails on unknown variables, including properties", () => {
    expect(() => render("{{ nope }}")).toThrow(/undefined variable/);
    expect(() => render("{{ business.nombre }}", { business: {} })).toThrow(/undefined variable/);
  });

  it("treats a missing optional value as false inside if (lenientIf)", () => {
    expect(render("{% if business.maps_url %}y{% else %}n{% endif %}", { business: {} })).toBe("n");
  });

  it("renders null as empty", () => {
    expect(render("[{{ v }}]", { v: null })).toBe("[]");
  });

  it.each(["include", "render", "layout", "cycle", "tablerow", "increment"])(
    "rejects the %s tag",
    (tag) => {
      expect(() => renderer.parse(`{% ${tag} 'x' %}`)).toThrow(/not found/);
    },
  );

  it("never reads object prototypes", () => {
    expect(() => render("{{ obj.constructor }}", { obj: {} })).toThrow(/undefined variable/);
  });

  it("stops runaway loops", () => {
    expect(() => render("{% for i in (1..100000000) %}{{ i }}{% endfor %}")).toThrow();
  });
});
