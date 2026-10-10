import type { Metadata } from "next";
import Link from "next/link";
import { currentMonth, usageReport } from "@platform/services";
import { Card, PageHeader, Table, Td, Th, cn } from "../../../components/ui.tsx";
import { usd } from "../../../lib/format.ts";
import { services } from "../../../lib/server.ts";
import { requireOwnerPage } from "../../../lib/session.ts";

export const metadata: Metadata = { title: "Usage" };

function shiftMonth(month: string, delta: number): string {
  const [y = 0, m = 1] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Spec §12 /usage: cost per business per month vs plan price, AI vs WhatsApp (ADR 0012). */
export default async function UsagePage(props: PageProps<"/usage">) {
  const actor = await requireOwnerPage();
  const query = await props.searchParams;
  const asked =
    typeof query.month === "string" && /^\d{4}-\d{2}$/.test(query.month) ? query.month : null;
  const month = asked ?? currentMonth(new Date(), "America/Bogota");
  const report = await usageReport(services(), actor, month);
  const money = (n: number) => `$${usd(n, n > 0 && n < 0.1 ? 4 : 2)}`;
  return (
    <>
      <PageHeader
        title="Usage and cost"
        description="AI spend as the API reported it; WhatsApp at Meta's per-message rates for Colombia (effective 2026-10-01)."
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link className="underline" href={`/usage?month=${shiftMonth(month, -1)}`}>
              ← {shiftMonth(month, -1)}
            </Link>
            <span className="font-medium">{month}</span>
            <Link className="underline" href={`/usage?month=${shiftMonth(month, 1)}`}>
              {shiftMonth(month, 1)} →
            </Link>
          </div>
        }
      />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Business</Th>
              <Th className="text-right">AI</Th>
              <Th className="text-right">WA marketing</Th>
              <Th className="text-right">WA utility</Th>
              <Th className="text-right">WA service</Th>
              <Th className="text-right">Total cost</Th>
              <Th className="text-right">Plan</Th>
              <Th className="text-right">Margin</Th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.businessId}>
                <Td>
                  <Link className="underline" href={`/businesses/${r.businessId}`}>
                    {r.name}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">{r.status}</span>
                </Td>
                <Td className="text-right">{money(r.aiUsd)}</Td>
                <Td className="text-right">{money(r.whatsapp.marketing)}</Td>
                <Td className="text-right">
                  {money(r.whatsapp.utility + r.whatsapp.authentication)}
                </Td>
                <Td className="text-right">{money(r.whatsapp.service)}</Td>
                <Td className="text-right font-medium">{money(r.totalUsd)}</Td>
                <Td className="text-right">
                  {r.planPriceUsd === null ? "—" : money(r.planPriceUsd)}
                </Td>
                <Td
                  className={cn(
                    "text-right",
                    r.marginUsd !== null && r.marginUsd < 0 && "text-destructive",
                  )}
                >
                  {r.marginUsd === null ? "—" : money(r.marginUsd)}
                </Td>
              </tr>
            ))}
            <tr className="font-medium">
              <Td>Total</Td>
              <Td className="text-right">{money(report.totals.aiUsd)}</Td>
              <Td colSpan={3} className="text-right">
                {money(report.totals.whatsappUsd)}
              </Td>
              <Td className="text-right">{money(report.totals.totalUsd)}</Td>
              <Td className="text-right">{money(report.totals.planUsd)}</Td>
              <Td />
            </tr>
          </tbody>
        </Table>
      </Card>
    </>
  );
}
