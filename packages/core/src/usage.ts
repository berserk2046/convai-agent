import { notifyStaff, withTenant, type Database } from "@platform/db";
import { alert, type Logger } from "@platform/shared";
import { DateTime } from "luxon";

/**
 * Usage warnings (principle 10, spec review C3). The business hears once a month when
 * usage reaches 90% of a monthly cap, and once when it reaches the cap itself (spending
 * then stops: AI turns hand off, marketing messages are skipped).
 */

export const USAGE_THRESHOLDS = [0.9, 1] as const;

export type UsageCap = "llm" | "marketing";

export async function warnOnUsage(
  deps: { db: Database; logger: Logger },
  input: {
    businessId: string;
    cap: UsageCap;
    used: number;
    limit: number;
    now: Date;
    timezone: string;
  },
): Promise<void> {
  const month = DateTime.fromJSDate(input.now, { zone: input.timezone }).toFormat("yyyy-MM");
  for (const threshold of USAGE_THRESHOLDS) {
    if (input.limit <= 0 || input.used < input.limit * threshold) continue;
    const percent = Math.round(threshold * 100);
    const created = await withTenant(deps.db, input.businessId, (tx) =>
      notifyStaff(tx, {
        businessId: input.businessId,
        kind: "usage",
        text: usageText(input.cap, threshold, input.used, input.limit),
        payload: { cap: input.cap, percent, used: input.used, limit: input.limit, month },
        dedupeKey: `usage:${input.cap}:${percent}:${month}`,
      }),
    );
    if (created) {
      alert(
        deps.logger,
        `usage_${input.cap}_${percent}`,
        { business_id: input.businessId, used: input.used, limit: input.limit },
        `monthly ${input.cap} usage reached ${percent}% of the cap`,
      );
    }
  }
}

/** Staff-facing text (Spanish UI label, like the admin's). */
export function usageText(cap: UsageCap, threshold: number, used: number, limit: number): string {
  if (cap === "llm") {
    return threshold < 1
      ? `Ya se usó el ${Math.round(threshold * 100)} % del límite mensual de inteligencia artificial (${usd(used)} de ${usd(limit)} USD). Al llegar al límite, las conversaciones pasan al equipo.`
      : `Se alcanzó el límite mensual de inteligencia artificial (${usd(limit)} USD). Hasta el próximo mes, las conversaciones pasan al equipo.`;
  }
  return threshold < 1
    ? `Ya se envió el ${Math.round(threshold * 100)} % de los mensajes de marketing del mes (${used} de ${limit}). Al llegar al límite, no se envían más.`
    : `Se alcanzó el límite mensual de mensajes de marketing (${limit}). Hasta el próximo mes no se envían más.`;
}

/** 13.5 → "13,50" (Colombian decimal comma). */
function usd(amount: number): string {
  return amount.toFixed(2).replace(".", ",");
}
