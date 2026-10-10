import type { Metadata } from "next";
import Link from "next/link";
import { monthlyReport } from "@platform/services";
import {
  Card,
  CardContent,
  CardHeader,
  PageHeader,
  Table,
  Td,
  Th,
} from "../../../components/ui.tsx";
import { usd } from "../../../lib/format.ts";
import { services } from "../../../lib/server.ts";
import { requireBusinessPage } from "../../../lib/session.ts";
import { reasonLabel } from "../inbox/labels.ts";

export const metadata: Metadata = { title: "Informes" };

/** Spec §12 /reports: one month at a time (business admins). */
export default async function ReportsPage(props: PageProps<"/reports">) {
  const actor = await requireBusinessPage({ adminOnly: true });
  const { month } = await props.searchParams;
  const asked = typeof month === "string" && /^\d{4}-\d{2}$/.test(month) ? month : undefined;
  const report = await monthlyReport(services(), actor, asked);
  const bookings = report.bookings.agent + report.bookings.staff + report.bookings.external;
  const money = (n: number) => `US$ ${usd(n)}`;
  return (
    <>
      <PageHeader
        title="Informes"
        description={`Cómo le fue al asistente en ${report.label}.`}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link className="underline" href={`/reports?month=${report.previous}`}>
              ← Mes anterior
            </Link>
            <span className="font-medium first-letter:uppercase">{report.label}</span>
            <Link className="underline" href={`/reports?month=${report.next}`}>
              Mes siguiente →
            </Link>
          </div>
        }
      />
      <div className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Conversaciones" value={report.conversations} />
          <Figure
            label="Resueltas sin una persona"
            value={report.resolvedPercent === null ? "—" : `${String(report.resolvedPercent)} %`}
            detail={`${String(report.resolvedWithoutHandoff)} de ${String(report.conversations)}`}
          />
          <Figure
            label="Citas agendadas"
            value={bookings}
            detail={`${String(report.bookings.agent)} por el asistente · ${String(report.bookings.staff)} por el equipo`}
          />
          <Figure
            label="Costo del mes"
            value={money(report.costs.totalUsd)}
            detail="Asistente y WhatsApp"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Citas del mes" description="Citas cuya fecha cae en este mes." />
            <Table>
              <tbody>
                <Row label="Citas" value={report.appointments.total} />
                <Row
                  label="Confirmadas por el cliente o el equipo"
                  value={report.appointments.confirmed}
                />
                <Row label="No asistieron" value={report.appointments.noShows} />
                <Row label="Canceladas" value={report.appointments.cancelled} />
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader
              title="Pasadas a una persona"
              description="Por qué el asistente pidió ayuda."
            />
            {report.handoffsByReason.length === 0 ? (
              <CardContent className="text-sm text-muted-foreground">Ninguna este mes.</CardContent>
            ) : (
              <Table>
                <tbody>
                  {report.handoffsByReason.map((h) => (
                    <Row key={h.reason} label={reasonLabel(h.reason, h.label)} value={h.count} />
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Mensajes automáticos enviados" />
            <Table>
              <tbody>
                {report.automations.map((a) => (
                  <Row key={a.key} label={a.description} value={a.count} />
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader
              title="Costo"
              description="Asistente: lo que cobró el servicio de IA. WhatsApp: tarifas de Meta para Colombia, por mensaje entregado."
            />
            <Table>
              <thead>
                <tr>
                  <Th>Concepto</Th>
                  <Th className="text-right">USD</Th>
                </tr>
              </thead>
              <tbody>
                <Row label="Asistente (IA)" value={money(report.costs.aiUsd)} />
                <Row
                  label="WhatsApp: marketing"
                  value={money(report.costs.byKind.wa_marketing ?? 0)}
                />
                <Row
                  label="WhatsApp: recordatorios y avisos"
                  value={money(report.costs.byKind.wa_utility ?? 0)}
                />
                <Row
                  label="WhatsApp: atención"
                  value={money(report.costs.byKind.wa_service ?? 0)}
                />
                <Row label="Total" value={money(report.costs.totalUsd)} strong />
              </tbody>
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}

function Figure({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <Card>
      <CardContent className="grid gap-1">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string | number;
  strong?: boolean;
}) {
  return (
    <tr className={strong ? "font-semibold" : undefined}>
      <Td>{label}</Td>
      <Td className="text-right tabular-nums">{value}</Td>
    </tr>
  );
}
