import { monthlyFigures, type UsageKind } from "@platform/db";
import { DateTime } from "luxon";
import { ADMIN_ONLY, type Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { ActionRefusedError } from "../errors.ts";
import { handoffLabels, inBusiness, pinnedTemplate } from "../tenancy.ts";
import { currentMonth, monthRange } from "../time.ts";

/**
 * /reports (spec §12): one month at a time — conversations and how many the bot resolved
 * without a person, bookings by who made them, confirmations, no-shows, automatic
 * messages sent (per rule), and cost. Business admins only.
 */

export interface MonthlyReport {
  month: string;
  label: string;
  previous: string;
  next: string;
  conversations: number;
  resolvedWithoutHandoff: number;
  /** 0–100, or null with no conversations. */
  resolvedPercent: number | null;
  /** `label` is the template's name for the reason, when it gives one. */
  handoffsByReason: { reason: string; label: string | null; count: number }[];
  bookings: { agent: number; staff: number; external: number };
  appointments: { total: number; confirmed: number; noShows: number; cancelled: number };
  automations: { key: string; description: string; count: number }[];
  costs: {
    aiUsd: number;
    whatsappUsd: number;
    totalUsd: number;
    byKind: Partial<Record<UsageKind, number>>;
  };
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

export function monthLabel(month: string): string {
  const [year, m] = month.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} de ${year ?? ""}`;
}

export async function monthlyReport(
  deps: ServiceDeps,
  actor: Actor,
  month?: string,
): Promise<MonthlyReport> {
  return inBusiness(deps, actor, ADMIN_ONLY, async (scope) => {
    const zone = scope.business.timezone;
    const chosen = month ?? currentMonth(deps.now(), zone);
    const range = monthRange(chosen, zone);
    if (!range) throw new ActionRefusedError("bad_month", "Mes no válido.");
    const { template } = await pinnedTemplate(scope);
    const figures = await monthlyFigures(scope.tx, scope.business.id, range.from, range.to);
    const bySource = (source: string) =>
      figures.bookingsBySource.find((b) => b.source === source)?.count ?? 0;
    const byKind = Object.fromEntries(figures.costs.map((c) => [c.kind, c.usd]));
    const aiUsd = figures.costs.filter((c) => c.kind === "llm").reduce((s, c) => s + c.usd, 0);
    const whatsappUsd = figures.costs
      .filter((c) => c.kind !== "llm")
      .reduce((s, c) => s + c.usd, 0);
    const start = DateTime.fromJSDate(range.from, { zone });

    return {
      month: chosen,
      label: monthLabel(chosen),
      previous: start.minus({ months: 1 }).toFormat("yyyy-MM"),
      next: start.plus({ months: 1 }).toFormat("yyyy-MM"),
      conversations: figures.conversations,
      resolvedWithoutHandoff: figures.withoutHandoff,
      resolvedPercent:
        figures.conversations === 0
          ? null
          : Math.round((figures.withoutHandoff / figures.conversations) * 100),
      handoffsByReason: figures.handoffsByReason.map((h) => ({
        ...h,
        label: handoffLabels(template)[h.reason] ?? null,
      })),
      bookings: {
        agent: bySource("agent"),
        staff: bySource("staff"),
        external: bySource("external"),
      },
      appointments: figures.appointments,
      automations: template.automations.map((rule) => ({
        key: rule.key,
        description: rule.description,
        count: figures.automationsSent.find((a) => a.ruleKey === rule.key)?.count ?? 0,
      })),
      costs: { aiUsd, whatsappUsd, totalUsd: aiUsd + whatsappUsd, byKind },
    };
  });
}
