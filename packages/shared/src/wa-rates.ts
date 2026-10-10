/**
 * WhatsApp Business Platform charges (ADR 0012). Meta charges per delivered message, by
 * category and by the recipient's market. Rates are Meta's list rates in USD, effective
 * 2026-10-01 ("Cost per message in USD" rate card, fetched 2026-10-09). Volume tiers only
 * start past 100,000 utility messages a month, so list rates apply. Update this table
 * when Meta publishes a new card.
 */

export const WA_RATES_EFFECTIVE_FROM = "2026-10-01";

interface MarketRates {
  marketing: number;
  utility: number;
  authentication: number;
  service: number;
}

/** By country calling code. Only Colombia for now: the platform's businesses are there. */
const MARKETS: Readonly<Record<string, { market: string; rates: MarketRates }>> = {
  "57": {
    market: "CO",
    rates: { marketing: 0.0125, utility: 0.0008, authentication: 0.0008, service: 0.0008 },
  },
};
const FALLBACK = MARKETS["57"] as { market: string; rates: MarketRates };

export type WaChargeKind = "wa_marketing" | "wa_utility" | "wa_auth" | "wa_service";

export interface WaCharge {
  kind: WaChargeKind;
  usd: number;
  market: string;
  /** No rate for that market here: Colombia's rate was used. */
  estimated: boolean;
}

const CATEGORY: Readonly<Record<string, [WaChargeKind, keyof MarketRates]>> = {
  marketing: ["wa_marketing", "marketing"],
  marketing_lite: ["wa_marketing", "marketing"],
  group_marketing: ["wa_marketing", "marketing"],
  utility: ["wa_utility", "utility"],
  group_utility: ["wa_utility", "utility"],
  authentication: ["wa_auth", "authentication"],
  "authentication-international": ["wa_auth", "authentication"],
  service: ["wa_service", "service"],
  group_service: ["wa_service", "service"],
};

/**
 * The charge for a message, from the `pricing` block of its status webhook. Meta's docs
 * (status webhook reference): `type: "regular"` means billable — that includes service
 * messages past the 1,000 free per number each month — and the `billable` flag is being
 * retired. Null when nothing is charged.
 */
export function waCharge(
  pricing: { billable: boolean | null; type: string | null; category: string | null },
  recipient: string,
): WaCharge | null {
  const billable = pricing.type === null ? pricing.billable === true : pricing.type === "regular";
  const category = pricing.category === null ? undefined : CATEGORY[pricing.category];
  if (!billable || !category) return null;
  const code = Object.keys(MARKETS).find((prefix) => recipient.startsWith(prefix));
  const entry = code ? MARKETS[code] : undefined;
  const [kind, rate] = category;
  return {
    kind,
    usd: (entry ?? FALLBACK).rates[rate],
    market: entry?.market ?? "unknown",
    estimated: entry === undefined,
  };
}
