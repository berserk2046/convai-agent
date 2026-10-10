import type { Metadata } from "next";
import Link from "next/link";
import { bookingsView } from "@platform/services";
import { ClosureForm } from "../../../components/closure-form.tsx";
import {
  Badge,
  Button,
  Card,
  buttonClass,
  CardContent,
  CardHeader,
  Empty,
  Input,
  PageHeader,
  cn,
} from "../../../components/ui.tsx";
import { isUuid } from "../../../lib/ids.ts";
import { services } from "../../../lib/server.ts";
import { requireBusinessPage } from "../../../lib/session.ts";
import { blockTimeAction } from "./actions.ts";
import { Calendar, DayNotes, STATUS_LABEL } from "./calendar.tsx";
import { BookingActions, MoveForm, NewBookingForm } from "./forms.tsx";
import { bookingsHref } from "./href.ts";

export const metadata: Metadata = { title: "Citas" };

const SOURCE: Record<string, string> = {
  agent: "Agendada por el asistente",
  staff: "Agendada por el equipo",
  external: "Agendada desde otro sistema",
};

export default async function BookingsPage(props: PageProps<"/bookings">) {
  const actor = await requireBusinessPage();
  const query = await props.searchParams;
  const one = (name: string) => {
    const value = query[name];
    return typeof value === "string" ? value : undefined;
  };
  const view = await bookingsView(services(), actor, {
    date: one("date"),
    view: one("view") === "week" ? "week" : "day",
  });
  const selectedId = one("booking");
  const selected = selectedId ? view.bookings.find((b) => b.id === selectedId) : undefined;
  const at = one("at");
  const resource = one("resource");
  const panel = selected ? "booking" : one("new") ? "new" : one("block") ? "block" : null;
  const here = { date: view.date, view: view.view };
  const atDefault = at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ? at : `${view.date}T08:00`;
  const resourceDefault =
    resource && isUuid(resource) && view.resources.some((r) => r.id === resource) ? resource : "";

  return (
    <>
      <PageHeader
        title="Citas"
        description={
          view.days.length === 1 ? view.days[0]?.label : `Semana del ${view.days[0]?.label ?? ""}`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className={buttonClass()} href={bookingsHref({ ...here, new: true })}>
              Nueva cita
            </Link>
            <Link
              className={buttonClass({ variant: "outline" })}
              href={bookingsHref({ ...here, block: true })}
            >
              Bloquear horario
            </Link>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link className={toolbar} href={bookingsHref({ ...here, date: view.previous })}>
          ← Anterior
        </Link>
        <Link className={toolbar} href={bookingsHref({ view: view.view })}>
          Hoy
        </Link>
        <Link className={toolbar} href={bookingsHref({ ...here, date: view.next })}>
          Siguiente →
        </Link>
        <form action="/bookings" className="flex items-center gap-2">
          {view.view === "week" ? <input type="hidden" name="view" value="week" /> : null}
          <Input
            type="date"
            name="date"
            defaultValue={view.date}
            className="h-8 w-40"
            aria-label="Ir a la fecha"
          />
          <Button size="sm" variant="outline">
            Ir
          </Button>
        </form>
        <div className="ml-auto flex gap-1 text-sm">
          <Link
            className={cn(tab, view.view === "day" && "bg-muted font-medium")}
            href={bookingsHref({ date: view.date })}
          >
            Día
          </Link>
          <Link
            className={cn(tab, view.view === "week" && "bg-muted font-medium")}
            href={bookingsHref({ date: view.date, view: "week" })}
          >
            Semana
          </Link>
        </div>
      </div>

      <div className={cn("grid items-start gap-6", panel ? "lg:grid-cols-[1fr_22rem]" : "")}>
        <div className="grid gap-3">
          <DayNotes view={view} />
          {view.resources.length === 0 ? (
            <Card>
              <Empty>
                No hay ningún {view.resourceLabel.toLowerCase()} activo. Agréguelo en Configuración.
              </Empty>
            </Card>
          ) : (
            <Calendar view={view} selected={selected?.id ?? null} />
          )}
        </div>

        {panel === "booking" && selected ? (
          <Card>
            <CardHeader
              title={selected.service}
              description={selected.label}
              actions={<CloseLink href={bookingsHref(here)} />}
            />
            <CardContent className="grid gap-4 text-sm">
              <div className="grid gap-1">
                <span>
                  <Badge
                    variant={
                      selected.status === "confirmed"
                        ? "success"
                        : selected.status === "pending"
                          ? "warning"
                          : "outline"
                    }
                  >
                    {STATUS_LABEL[selected.status] ?? selected.status}
                  </Badge>{" "}
                  <span className="text-muted-foreground">
                    {SOURCE[selected.source] ?? selected.source}
                  </span>
                </span>
                <span>
                  {view.resourceLabel}:{" "}
                  {view.resources.find((r) => r.id === selected.resourceId)?.name ?? "—"}
                </span>
                <span>
                  {selected.subjectName}
                  {selected.subjectName !== selected.who ? ` (cliente: ${selected.who})` : ""} · +
                  {selected.waNumber}
                </span>
                {selected.notes ? (
                  <span className="text-muted-foreground">{selected.notes}</span>
                ) : null}
                {selected.conversationId ? (
                  <Link className="underline" href={`/inbox/${selected.conversationId}`}>
                    Ver la conversación
                  </Link>
                ) : null}
              </div>
              <BookingActions bookingId={selected.id} status={selected.status} />
              {selected.status === "pending" || selected.status === "confirmed" ? (
                <details className="border-t border-border pt-3">
                  <summary className="cursor-pointer font-medium">Mover la cita</summary>
                  <div className="pt-3">
                    <MoveForm
                      bookingId={selected.id}
                      startsAt={selected.startsAt}
                      resourceId={selected.resourceId}
                      resources={view.resources}
                      resourceLabel={view.resourceLabel}
                    />
                  </div>
                </details>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {panel === "new" ? (
          <Card>
            <CardHeader title="Nueva cita" actions={<CloseLink href={bookingsHref(here)} />} />
            <CardContent>
              <NewBookingForm
                services={view.services}
                resources={view.resources}
                resourceLabel={view.resourceLabel}
                defaults={{ startsAt: atDefault, resourceId: resourceDefault }}
              />
            </CardContent>
          </Card>
        ) : null}

        {panel === "block" ? (
          <Card>
            <CardHeader
              title="Bloquear horario"
              description="En ese horario no se ofrecen citas. Las citas que ya existen no se cancelan."
              actions={<CloseLink href={bookingsHref(here)} />}
            />
            <CardContent>
              <ClosureForm
                action={blockTimeAction}
                resources={view.resources}
                defaults={{ from: atDefault, resourceId: resourceDefault }}
                compact
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}

const toolbar = buttonClass({ variant: "outline", size: "sm" });
const tab = "rounded-md px-3 py-1 text-muted-foreground hover:text-foreground";

function CloseLink({ href }: { href: string }) {
  return (
    <Link href={href} aria-label="Cerrar" className="text-muted-foreground hover:text-foreground">
      ✕
    </Link>
  );
}
