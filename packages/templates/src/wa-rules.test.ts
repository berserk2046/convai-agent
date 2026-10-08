import { describe, expect, it } from "vitest";
import type { WaTemplate } from "./meta-schema.ts";
import { checkWaTemplate, metaTemplateName, parameterValueProblem } from "./wa-rules.ts";

function template(
  body: string,
  variableCount: number,
  overrides: Partial<WaTemplate> = {},
): WaTemplate {
  return {
    key: "recordatorio",
    category: "UTILITY",
    language: "es",
    body,
    variables: Array.from({ length: variableCount }, () => "contact.name"),
    examples: Array.from({ length: variableCount }, (_, i) => `ejemplo ${i + 1}`),
    buttons: [],
    ...overrides,
  };
}

const errors = (t: WaTemplate) =>
  checkWaTemplate(t)
    .filter((i) => i.severity === "error")
    .map((i) => i.message);

describe("checkWaTemplate", () => {
  it("accepts a well-formed body", () => {
    expect(
      checkWaTemplate(
        template("Hola {{1}}, le recordamos su cita de {{2}} mañana. ¿Nos confirma?", 2),
      ),
    ).toEqual([]);
  });

  it.each([
    ["{{1}}, le recordamos su cita de mañana en la clínica.", 1, /must not start/],
    ["Le recordamos su cita de mañana, {{1}}", 1, /must not end/],
    ["Hola {{1}} {{2}}, le recordamos su cita de mañana.", 2, /nothing between/],
    ["Hola {{2}}, le recordamos su cita de {{1}} mañana.", 2, /numbered 1, 2, 3/],
    ["Hola {{1}}, su cita de {{3}} es mañana en la clínica.", 2, /numbered 1, 2, 3/],
    ["Hola {{1}}, su cita con {{1}} es mañana en la clínica.", 1, /more than once/],
    ["Hola {{ 1 }}, le recordamos su cita de mañana.", 1, /must be a number/],
    ["Hola {{name}}, le recordamos su cita de mañana.", 1, /must be a number/],
    ["Hola {{1}, le recordamos su cita de mañana.", 0, /mismatched curly braces/],
  ])("rejects %s", (body, count, message) => {
    expect(errors(template(body, count))).toEqual(
      expect.arrayContaining([expect.stringMatching(message)]),
    );
  });

  it("requires one variable and one sample per placeholder", () => {
    const t = template("Hola {{1}}, su cita de {{2}} es mañana en la clínica.", 2, {
      variables: ["contact.name"],
      examples: ["Laura"],
    });
    expect(errors(t)).toEqual([
      "has 1 entries but the body has 2 placeholders",
      "has 1 entries but the body has 2 placeholders (Meta requires one sample each)",
    ]);
  });

  it("warns when placeholders outnumber the fixed text", () => {
    const issues = checkWaTemplate(template("Hola {{1}} {{2}}x {{3}}y gracias.", 3));
    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringMatching(/too many variables/),
      }),
    );
  });

  it("rejects duplicate button payloads", () => {
    const t = template("Hola {{1}}, ¿nos confirma su cita de mañana?", 1, {
      buttons: [
        { type: "QUICK_REPLY", text: "Sí", payload: "confirm" },
        { type: "QUICK_REPLY", text: "Confirmo", payload: "confirm" },
      ],
    });
    expect(errors(t)).toEqual(['"confirm" is used twice']);
  });
});

describe("parameterValueProblem", () => {
  it.each([
    ["Laura", null],
    ["", "must not be empty"],
    ["a\nb", "must not contain newlines or tabs"],
    ["a     b", "must not contain more than 4 consecutive spaces"],
  ])("%j → %s", (value, problem) => {
    expect(parameterValueProblem(value)).toBe(problem);
  });
});

it("names Meta templates <key>_v<major>", () => {
  expect(metaTemplateName("recordatorio_cita", 1)).toBe("recordatorio_cita_v1");
});
