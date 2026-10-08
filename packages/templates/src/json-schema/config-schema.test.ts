import { describe, expect, it } from "vitest";
import { compileObjectSchema, validateWithSchema, type CompiledSchema } from "./config-schema.ts";

function compile(schema: unknown): CompiledSchema {
  const result = compileObjectSchema(schema);
  if (!result.compiled) throw new Error(JSON.stringify(result.issues));
  return result.compiled;
}

const schema = compile({
  type: "object",
  required: ["phone", "hours"],
  properties: {
    phone: { $ref: "platform:phone_co", title: "Teléfono" },
    site: { $ref: "platform:url" },
    price: { $ref: "platform:money_cop" },
    duration: { $ref: "platform:duration_min" },
    hours: { $ref: "platform:weekly_hours", "x-ui": { widget: "weekly-hours" } },
    bookable: { type: "boolean", default: true },
  },
});

describe("platform types", () => {
  it.each([
    "3000000000",
    "300 000 0000",
    "+57 300 000 0000",
    "+573001234567",
    "604 444 5555",
    "601-234-5678",
  ])("accepts phone %s", (phone) => {
    expect(validateWithSchema(schema, { phone, hours: {} }).ok).toBe(true);
  });

  it.each(["123", "2000000000", "+1 300 000 0000", "300-000-000", "30000000001"])(
    "rejects phone %s",
    (phone) => {
      expect(validateWithSchema(schema, { phone, hours: {} })).toMatchObject({
        ok: false,
        issues: [{ path: ["phone"] }],
      });
    },
  );

  it("accepts http(s) URLs only", () => {
    const base = { phone: "3000000000", hours: {} };
    expect(validateWithSchema(schema, { ...base, site: "https://example.com/x" }).ok).toBe(true);
    expect(validateWithSchema(schema, { ...base, site: "ftp://example.com" }).ok).toBe(false);
    expect(validateWithSchema(schema, { ...base, site: "example.com" }).ok).toBe(false);
  });

  it("checks money and duration rules", () => {
    const base = { phone: "3000000000", hours: {} };
    expect(validateWithSchema(schema, { ...base, price: -1 }).ok).toBe(false);
    expect(validateWithSchema(schema, { ...base, price: 1.5 }).ok).toBe(false);
    expect(validateWithSchema(schema, { ...base, duration: 45 }).ok).toBe(true);
    expect(validateWithSchema(schema, { ...base, duration: 42 }).ok).toBe(false);
  });
});

describe("validateWithSchema", () => {
  it("applies defaults, including every day of the week", () => {
    const result = validateWithSchema(schema, {
      phone: "3000000000",
      hours: { mon: [{ open: "08:00", close: "12:00" }] },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        bookable: true,
        hours: { mon: [{ open: "08:00", close: "12:00" }], tue: [], sun: [] },
      },
    });
  });

  it("does not mutate its input", () => {
    const input = { phone: "3000000000", hours: {} };
    validateWithSchema(schema, input);
    expect(input).toEqual({ phone: "3000000000", hours: {} });
  });

  it("reports missing and unknown fields at their own path", () => {
    const result = validateWithSchema(schema, { hours: { mon: [], funday: [] } });
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: ["phone"], message: "is required" },
        { path: ["hours", "funday"], message: "is not allowed" },
      ],
    });
  });

  it.each([
    [[{ open: "12:00", close: "08:00" }], "opens at 12:00 but closes at 08:00"],
    [[{ open: "08:00", close: "08:00" }], "opens at 08:00 but closes at 08:00"],
    [
      [
        { open: "08:00", close: "12:00" },
        { open: "11:00", close: "14:00" },
      ],
      "overlaps or is out of order",
    ],
  ])("rejects bad hours %j", (mon, message) => {
    const result = validateWithSchema(schema, { phone: "3000000000", hours: { mon } });
    expect(result).toMatchObject({
      ok: false,
      issues: [
        { path: ["hours", "mon", expect.any(Number)], message: expect.stringContaining(message) },
      ],
    });
  });

  it("allows a range that ends at midnight", () => {
    expect(
      validateWithSchema(schema, {
        phone: "3000000000",
        hours: { fri: [{ open: "18:00", close: "24:00" }] },
      }).ok,
    ).toBe(true);
  });
});

describe("compileObjectSchema", () => {
  it.each([
    [
      { type: "object", properties: { a: { $ref: "platform:money_usd" } } },
      ["properties", "a", "$ref"],
      /unknown platform type/,
    ],
    [
      { type: "object", properties: { a: { $ref: "platform:money_cop", minimum: 5 } } },
      ["properties", "a", "minimum"],
      /can't be combined/,
    ],
    [
      { type: "object", properties: { a: { $ref: "https://evil.example/schema" } } },
      ["properties", "a", "$ref"],
      /only "platform:<type>"/,
    ],
    [
      { type: "object", properties: { a: { type: "string", maxLenght: 3 } } },
      ["properties", "a", "maxLenght"],
      /unknown keyword/,
    ],
    [
      { type: "object", properties: { a: { type: "strin" } } },
      ["properties", "a", "type"],
      /must be/,
    ],
    [
      { type: "object", properties: { a: { type: "string", "x-ui": { widget: "slider" } } } },
      ["properties", "a", "x-ui", "widget"],
      /must be/,
    ],
    [{ type: "array" }, ["type"], /must be "object" at the root/],
  ])("rejects %j", (raw, path, message) => {
    const result = compileObjectSchema(raw);
    expect(result.compiled).toBeNull();
    expect(result.issues).toContainEqual({ path, message: expect.stringMatching(message) });
  });
});
