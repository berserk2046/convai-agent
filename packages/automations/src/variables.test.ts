import { describe, expect, it } from "vitest";
import { decodeButtonPayload, encodeButtonPayload } from "./payload.ts";
import { fillBody, resolveVariables } from "./variables.ts";

const template = {
  key: "recordatorio_cita",
  category: "UTILITY" as const,
  language: "es" as const,
  body: "Hola {{1}}, su cita de {{2}} es el {{3}}.",
  variables: [
    { paths: ["contact.name", "booking.subject_name"] },
    "booking.service_name",
    { paths: ["booking.date_long"], fallback: "próximo día" },
  ],
  examples: ["Laura", "Limpieza", "jueves"],
  buttons: [],
};

describe("resolveVariables (decision A10)", () => {
  it("takes the first non-empty path, then the fallback", () => {
    const resolved = resolveVariables(template, {
      contact: { name: null },
      booking: { subject_name: "Ana  Pérez\n", service_name: "Limpieza dental", date_long: "" },
    });
    expect(resolved).toEqual({ ok: true, values: ["Ana Pérez", "Limpieza dental", "próximo día"] });
    if (resolved.ok) {
      expect(fillBody(template.body, resolved.values)).toBe(
        "Hola Ana Pérez, su cita de Limpieza dental es el próximo día.",
      );
    }
  });

  it("reports a variable that stays empty (Meta rejects empty parameters)", () => {
    expect(
      resolveVariables(template, { contact: { name: null }, booking: { subject_name: " " } }),
    ).toEqual({ ok: false, missing: "contact.name | booking.subject_name" });
  });
});

describe("button payloads", () => {
  it("round-trip rule, run and payload", () => {
    const p = {
      ruleKey: "recordatorio_24h",
      runId: "7d3c2f1e-0000-4000-8000-000000000001",
      payload: "confirm",
    };
    expect(decodeButtonPayload(encodeButtonPayload(p))).toEqual(p);
    expect(decodeButtonPayload("Unsubscribe")).toBeNull();
  });
});
