import { compileTemplateRegex } from "@platform/templates";
import { DateTime } from "luxon";

/**
 * Deterministic guardrails (spec §7, steps 2 and 6). Small pure functions: the template
 * supplies the words and patterns, these decide.
 */

/** Lowercase, accents removed, punctuation and emoji turned into spaces, spaces collapsed. */
export function normalize(text: string): string {
  return stripAccents(text.toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Emergency patterns (`iu`) checked against the text as written and without accents, so
 * "hinchazon" matches like "hinchazón" (spec review B17: err on the safe side).
 */
export function matchesEmergency(text: string, patterns: readonly string[]): boolean {
  const plain = stripAccents(text);
  return patterns.some((source) => {
    const regex = compileTemplateRegex(source);
    return regex.test(text) || regex.test(plain);
  });
}

/**
 * Opt-out (decision A2). A single-word keyword ("PARA", "STOP") counts only when it is the
 * whole batch, so "tengo la presión baja" or "para mañana" never opt anyone out. A phrase
 * ("no me escriban") counts anywhere, as whole words. Case and accents are ignored. The
 * batch is everything the person sent in one burst, so a lone "Para" fragment followed by
 * "mañana a las 10" doesn't match either.
 */
export function matchesOptOut(batchText: string, keywords: readonly string[]): boolean {
  const text = normalize(batchText);
  if (text === "") return false;
  return keywords.some((keyword) => {
    const k = normalize(keyword);
    if (k === "") return false;
    return k.includes(" ") ? ` ${text} `.includes(` ${k} `) : text === k;
  });
}

/** Consent acceptance (`accept_patterns`, compiled `iu`). */
export function matchesAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((source) => compileTemplateRegex(source).test(text));
}

// --- price guard (principle 4) ---------------------------------------------------------------

const DIGITS = String.raw`\d{1,3}(?:[.,]\d{3})+|\d+`;
const MONEY_PATTERNS: { regex: RegExp; scale: (match: RegExpMatchArray) => number }[] = [
  // "1,2 millones", "2 millones", "1 millón"
  { regex: /(\d+(?:[.,]\d+)?)\s*mill(?:ón|on|ones)\b/giu, scale: (m) => scaled(m[1], 1_000_000) },
  // "120 mil", "1,5 mil"
  { regex: /(\d+(?:[.,]\d+)?)\s*mil\b/giu, scale: (m) => scaled(m[1], 1_000) },
  // "120k"
  { regex: /(\d+(?:[.,]\d+)?)\s*k\b/giu, scale: (m) => scaled(m[1], 1_000) },
  // "$120.000", "$ 50.000", "$1,200,000", "$120"
  { regex: new RegExp(String.raw`\$\s?(${DIGITS})`, "gu"), scale: (m) => integer(m[1]) },
  // "120.000" (thousands separators, no symbol); phone numbers and times don't match
  { regex: /(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+)(?![\d.,]*\d)/gu, scale: (m) => integer(m[1]) },
];

/**
 * Money amounts in a reply: "$" amounts, numbers with thousands separators, "X mil",
 * "X millones" and "Xk" (spec §7.6). Each text span is counted once, by the first pattern
 * that matches it.
 */
export function extractMoneyAmounts(text: string): number[] {
  const taken: [number, number][] = [];
  const amounts: number[] = [];
  for (const { regex, scale } of MONEY_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken.some(([s, e]) => start < e && s < end)) continue;
      taken.push([start, end]);
      amounts.push(scale(match));
    }
  }
  return amounts;
}

function integer(value: string | undefined): number {
  return Number((value ?? "").replace(/[.,\s]/g, ""));
}

/** "4,1" × 1 000 000 → 4 100 000. Rounded: in floating point it is 4099999.9999999995. */
function scaled(value: string | undefined, factor: number): number {
  return Math.round(Number((value ?? "").replace(",", ".")) * factor);
}

/** Price types whose amount may be quoted (decision A14). */
const QUOTABLE_PRICE_TYPES = new Set(["fixed", "from"]);

/**
 * Prices the agent may mention: catalog items priced "fixed" or "from". An
 * "after_evaluation" item's amount is never allowed, even if the config has one.
 */
export function allowedPrices(
  catalog: readonly Record<string, unknown>[],
  priceField: string,
  priceTypeField: string | undefined,
): Set<number> {
  const prices = new Set<number>();
  for (const item of catalog) {
    const price = item[priceField];
    const type = priceTypeField === undefined ? "fixed" : item[priceTypeField];
    if (typeof price === "number" && typeof type === "string" && QUOTABLE_PRICE_TYPES.has(type))
      prices.add(price);
  }
  return prices;
}

/** Amounts in the reply that aren't catalog prices. Empty = the reply passes. */
export function priceViolations(text: string, allowed: ReadonlySet<number>): number[] {
  return extractMoneyAmounts(text).filter((amount) => !allowed.has(amount));
}

// --- reply length (decision A8) -------------------------------------------------------------------

export interface Trimmed {
  text: string;
  trimmed: boolean;
}

/**
 * Hard cap at 1.5× `max_reply_words` (the prompt asks for the soft limit). Cuts at the
 * last sentence end before the cap; without one, at the cap with an ellipsis.
 */
export function capReplyLength(text: string, maxWords: number): Trimmed {
  const hardCap = Math.floor(maxWords * 1.5);
  const words = text.trim().split(/\s+/);
  if (words.length <= hardCap) return { text: text.trim(), trimmed: false };
  const head = words.slice(0, hardCap).join(" ");
  const lastEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("? "),
    head.lastIndexOf("! "),
    endsSentence(head) ? head.length - 1 : -1,
  );
  const cut = lastEnd > 0 ? head.slice(0, lastEnd + 1) : `${head}…`;
  return { text: cut.trim(), trimmed: true };
}

function endsSentence(text: string): boolean {
  return /[.?!]$/.test(text);
}

// --- budget (principle 10) ---------------------------------------------------------------------------

/** Start of the current month in the business's timezone, as an instant. */
export function monthStart(now: Date, timezone: string): Date {
  return DateTime.fromJSDate(now, { zone: timezone }).startOf("month").toJSDate();
}
