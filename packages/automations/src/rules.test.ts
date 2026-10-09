import { readFileSync } from "node:fs";
import { validateTemplateSource } from "@platform/templates";
import { describe, expect, it } from "vitest";
import { effectiveTrigger, findRule, minutesParam, overrideProblems } from "./rules.ts";

const template = validateTemplateSource(
  readFileSync(new URL("../../../templates/odontologia/template.yaml", import.meta.url), "utf8"),
).template;
if (!template) throw new Error("odontologia must validate");
const reminder = findRule(template, "recordatorio_24h");
if (!reminder) throw new Error("missing rule");

describe("effective triggers", () => {
  it("apply a business's override of an overridable param", () => {
    expect(effectiveTrigger(reminder, {})?.params).toEqual({ offset: "-24h" });
    const trigger = effectiveTrigger(reminder, { "trigger.offset": "-48h" });
    expect(trigger).toMatchObject({ type: "booking.starts_in", subject: "booking" });
    expect(minutesParam(trigger?.params ?? {}, "offset")).toBe(-48 * 60);
  });

  it("validate overrides against the rule", () => {
    expect(overrideProblems(reminder, { "trigger.offset": "-2h" })).toEqual([]);
    expect(overrideProblems(reminder, { "trigger.offset": "2h" })).toEqual([
      'trigger.offset: must be negative, e.g. "-24h"',
    ]);
    expect(overrideProblems(reminder, { "trigger.type": "schedule" })).toEqual([
      "trigger.type: can't be changed for recordatorio_24h",
    ]);
  });

  it("ignore an override the rule doesn't allow", () => {
    expect(effectiveTrigger(reminder, { "trigger.other": "1h" })?.params).toEqual({
      offset: "-24h",
    });
  });
});
