import { describe, expect, it } from "vitest";
import {
  allowedPrices,
  capReplyLength,
  extractMoneyAmounts,
  matchesAny,
  matchesEmergency,
  matchesOptOut,
  monthStart,
  priceViolations,
} from "./guardrails.ts";

/** templates/odontologia guardrails and consent. */
const EMERGENCY = [
  "cara\\s+hinchad",
  "hinchaz[oó]n",
  "sangr\\w*\\s+(mucho|much[ií]simo|sin parar|no para)",
  "(part|romp|quebr|tumb)[a-záéíóúñ]*\\s+(un|el|una|la|dos|los|las|varios)\\s+(dientes?|muelas?)",
  "golpe\\s+(en|fuerte)",
  "fiebre",
  "no\\s+puedo\\s+(abrir|tragar|respirar)",
  "dolor\\s+(insoportable|horrible|terrible)",
];
const OPT_OUT = ["PARA", "STOP", "no más mensajes", "no me escriban"];
const ACCEPT = [
  "^\\s*s[ií](?![a-zñáéíóú])",
  "\\bacepto",
  "de acuerdo",
  "^\\s*ok(?![a-z])",
  "^\\s*dale(?![a-z])",
];

describe("matchesEmergency", () => {
  it.each([
    "Me duele muchísimo una muela y tengo la cara hinchada",
    "Hola, me golpearon y se me partió un diente, tengo la cara hinchada",
    "tengo HINCHAZON en la encía", // no accent, uppercase
    "me sangra mucho la encía",
    "no puedo abrir la boca",
  ])("flags %s", (text) => {
    expect(matchesEmergency(text, EMERGENCY)).toBe(true);
  });

  it.each(["Hola, quiero una limpieza", "¿Cuánto vale una calza?", "me duele un poco"])(
    "leaves %s alone",
    (text) => {
      expect(matchesEmergency(text, EMERGENCY)).toBe(false);
    },
  );
});

describe("matchesOptOut (decision A2)", () => {
  it.each([
    "PARA",
    "para",
    "Para.",
    "  stop!! ",
    "STOP 🛑",
    "No más mensajes por favor",
    "no me escriban más",
    "NO MAS MENSAJES",
  ])("opts out: %j", (text) => {
    expect(matchesOptOut(text, OPT_OUT)).toBe(true);
  });

  it.each([
    "Para mañana a las 10",
    "¿Para qué sirve la limpieza?",
    "Tengo la presión baja",
    "Para\nmañana a las 10", // one burst: fragments are judged together
    "parar",
    "",
  ])("does not opt out: %j", (text) => {
    expect(matchesOptOut(text, OPT_OUT)).toBe(false);
  });
});

describe("matchesAny (consent acceptance)", () => {
  it.each(["Sí", "si", "SI, claro", "Acepto", "estoy de acuerdo", "ok", "Dale"])(
    "accepts %j",
    (text) => {
      expect(matchesAny(text, ACCEPT)).toBe(true);
    },
  );

  it.each(["sin problema", "Hola", "okey no sé", "No"])("doesn't accept %j", (text) => {
    expect(matchesAny(text, ACCEPT)).toBe(false);
  });
});

describe("extractMoneyAmounts", () => {
  it.each([
    ["La limpieza cuesta $120.000.", [120000]],
    ["Desde $ 180.000, y la valoración $50.000", [180000, 50000]],
    ["Son 120.000 pesos", [120000]],
    ["Cuesta 120 mil", [120000]],
    ["Alrededor de $120 mil", [120000]],
    ["Unos 1,2 millones", [1200000]],
    ["Unos 4,1 millones", [4100000]],
    ["Son 16,1 mil", [16100]],
    ["Vale 600k", [600000]],
    ["$1,200,000 en total", [1200000]],
  ])("%s → %j", (text, amounts) => {
    expect(extractMoneyAmounts(text)).toEqual(amounts);
  });

  it.each([
    "Llame al 3000000000 para urgencias",
    "Le espero a las 3:00 p. m. del jueves 8 de octubre",
    "Calle 00 # 00-00, Aranjuez",
    "La cita dura 45 min.",
    "Llame al +57 300 000 0000",
    "Nos vemos en 2026",
  ])("finds no money in %j", (text) => {
    expect(extractMoneyAmounts(text)).toEqual([]);
  });
});

describe("price guard (principle 4, decision A14)", () => {
  const catalog = [
    { key: "limpieza", price_type: "fixed", price_cop: 120000 },
    { key: "resina", price_type: "from", price_cop: 180000 },
    { key: "endodoncia", price_type: "after_evaluation", price_cop: 900000 },
    { key: "ortodoncia", price_type: "after_evaluation" },
  ];
  const allowed = allowedPrices(catalog, "price_cop", "price_type");

  it("allows fixed and 'from' prices only", () => {
    expect([...allowed].sort()).toEqual([120000, 180000]);
  });

  it("flags invented amounts and after-evaluation amounts", () => {
    expect(
      priceViolations("La limpieza vale $120.000 y la resina desde $180.000", allowed),
    ).toEqual([]);
    expect(priceViolations("La limpieza vale $100.000", allowed)).toEqual([100000]);
    expect(priceViolations("La endodoncia cuesta $900.000", allowed)).toEqual([900000]);
    expect(priceViolations("Las dos juntas salen en 300 mil", allowed)).toEqual([300000]);
  });
});

describe("capReplyLength (decision A8)", () => {
  it("leaves replies up to 1.5× the limit alone", () => {
    const text = Array.from({ length: 15 }, () => "palabra").join(" ");
    expect(capReplyLength(text, 10)).toEqual({ text, trimmed: false });
  });

  it("cuts at the last sentence end before the hard cap", () => {
    const text =
      "Primera frase corta. Segunda frase también corta? Tercera frase que se pasa del límite permitido por mucho.";
    expect(capReplyLength(text, 6)).toEqual({
      text: "Primera frase corta. Segunda frase también corta?",
      trimmed: true,
    });
  });

  it("cuts mid-sentence with an ellipsis when there is no sentence end", () => {
    const text = Array.from({ length: 20 }, (_, i) => `p${String(i)}`).join(" ");
    expect(capReplyLength(text, 4)).toEqual({ text: "p0 p1 p2 p3 p4 p5…", trimmed: true });
  });
});

describe("monthStart", () => {
  it("uses the business's month, not UTC's", () => {
    // 1 Nov 03:00 UTC is still 31 Oct in Bogotá.
    expect(monthStart(new Date("2026-11-01T03:00:00Z"), "America/Bogota").toISOString()).toBe(
      "2026-10-01T05:00:00.000Z",
    );
  });
});
