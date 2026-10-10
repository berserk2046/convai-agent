import { listBusinessesForUsage, usageCosts } from "@platform/db";
import { requireOwner, type Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { ActionRefusedError } from "../errors.ts";
import { monthRange } from "../time.ts";

/**
 * /usage (spec §12, platform owner): what each business cost in a month — AI and WhatsApp
 * by category — against its plan price. Each business's month runs in its own timezone.
 * Costs are what usage_events recorded: AI spend as the API reported it, WhatsApp charges
 * from Meta's per-message pricing (ADR 0012).
 */

export interface UsageRow {
  businessId: string;
  name: string;
  status: string;
  aiUsd: number;
  whatsapp: { marketing: number; utility: number; authentication: number; service: number };
  whatsappUsd: number;
  totalUsd: number;
  planPriceUsd: number | null;
  /** Plan price minus cost; null without a plan price. */
  marginUsd: number | null;
}

export async function usageReport(
  deps: ServiceDeps,
  actor: Actor,
  month: string,
): Promise<{
  month: string;
  rows: UsageRow[];
  totals: { aiUsd: number; whatsappUsd: number; totalUsd: number; planUsd: number };
}> {
  requireOwner(actor);
  if (!/^\d{4}-\d{2}$/.test(month))
    throw new ActionRefusedError("bad_month", "Month must look like 2026-10");
  const rows: UsageRow[] = [];
  for (const business of await listBusinessesForUsage(deps.db)) {
    const range = monthRange(month, business.timezone);
    if (!range) continue;
    const costs = await usageCosts(deps.db, business.id, range.from, range.to);
    const usd = (kind: string) => costs.find((c) => c.kind === kind)?.usd ?? 0;
    const whatsapp = {
      marketing: usd("wa_marketing"),
      utility: usd("wa_utility"),
      authentication: usd("wa_auth"),
      service: usd("wa_service"),
    };
    const whatsappUsd = Object.values(whatsapp).reduce((a, b) => a + b, 0);
    const aiUsd = usd("llm");
    const plan = business.planPriceUsd === null ? null : Number(business.planPriceUsd);
    rows.push({
      businessId: business.id,
      name: business.name,
      status: business.status,
      aiUsd,
      whatsapp,
      whatsappUsd,
      totalUsd: aiUsd + whatsappUsd,
      planPriceUsd: plan,
      marginUsd: plan === null ? null : plan - aiUsd - whatsappUsd,
    });
  }
  const sum = (f: (r: UsageRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    month,
    rows,
    totals: {
      aiUsd: sum((r) => r.aiUsd),
      whatsappUsd: sum((r) => r.whatsappUsd),
      totalUsd: sum((r) => r.totalUsd),
      planUsd: sum((r) => r.planPriceUsd ?? 0),
    },
  };
}
