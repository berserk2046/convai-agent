import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { BookingsView } from "@platform/services";
import { Badge, cn } from "../../../components/ui.tsx";
import { minuteLabel } from "../../../lib/format.ts";
import { bookingsHref } from "./href.ts";

/**
 * The day view has a column per resource; the week view a column per day, with a lane per
 * resource inside it. Bookings never overlap within a resource (the exclusion constraint),
 * so lanes keep every booking visible.
 */

const PX_PER_MINUTE = 0.8;
const SLOT_MIN = 30;

export const STATUS_LABEL: Record<string, string> = {
  pending: "Sin confirmar",
  confirmed: "Confirmada",
  completed: "Atendida",
  no_show: "No asistió",
};

const STATUS_STYLE: Record<string, string> = {
  pending: "border-warning bg-warning/15",
  confirmed: "border-success bg-success/15",
  completed: "border-border bg-muted text-muted-foreground",
  no_show: "border-destructive/50 bg-destructive/5 text-muted-foreground line-through",
};

interface Column {
  key: string;
  date: string;
  header: ReactNode;
  lanes: string[];
}

export function Calendar({ view, selected }: { view: BookingsView; selected: string | null }) {
  const { from, to } = view.grid;
  const height = (to - from) * PX_PER_MINUTE;
  const day = view.days[0];
  const columns: Column[] =
    view.view === "day" && day
      ? view.resources.map((r) => ({ key: r.id, date: day.date, header: r.name, lanes: [r.id] }))
      : view.days.map((d) => ({
          key: d.date,
          date: d.date,
          header: (
            <Link href={bookingsHref({ date: d.date, view: "day" })} className="hover:underline">
              {d.label}
            </Link>
          ),
          lanes: view.resources.map((r) => r.id),
        }));
  const resourceName = new Map(view.resources.map((r) => [r.id, r.name]));
  const hours = Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60);
  const top = (minute: number) => (minute - from) * PX_PER_MINUTE;
  const lines: CSSProperties = {
    height,
    backgroundImage: `repeating-linear-gradient(to bottom, var(--color-border) 0 1px, transparent 1px ${String(60 * PX_PER_MINUTE)}px)`,
  };

  if (columns.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <div
        className="grid min-w-fit"
        style={{
          gridTemplateColumns: `4rem repeat(${String(columns.length)}, minmax(${view.view === "day" ? "10rem" : "7.5rem"}, 1fr))`,
        }}
      >
        <div className="sticky left-0 border-b border-border bg-card" />
        {columns.map((c) => (
          <div
            key={c.key}
            className="border-b border-l border-border px-2 py-2 text-sm font-medium"
          >
            {c.header}
          </div>
        ))}

        <div className="relative sticky left-0 z-10 bg-card" style={{ height }}>
          {hours.map((h) => (
            <span
              key={h}
              className="absolute right-2 -translate-y-1/2 text-xs text-muted-foreground"
              style={{ top: top(h) }}
            >
              {h === from ? "" : minuteLabel(h)}
            </span>
          ))}
        </div>

        {columns.map((c) => (
          <div key={c.key} className="relative border-l border-border" style={lines}>
            {view.view === "day"
              ? Array.from({ length: (to - from) / SLOT_MIN }, (_, i) => from + i * SLOT_MIN).map(
                  (m) => (
                    <Link
                      key={m}
                      href={bookingsHref({
                        date: c.date,
                        view: "day",
                        new: true,
                        at: `${c.date}T${hhmm(m)}`,
                        resource: c.lanes[0],
                      })}
                      className="absolute inset-x-0 hover:bg-muted"
                      style={{ top: top(m), height: SLOT_MIN * PX_PER_MINUTE }}
                      aria-label={`Nueva cita a las ${minuteLabel(m)}${c.lanes.length === 1 ? ` en ${String(resourceName.get(c.lanes[0] ?? ""))}` : ""}`}
                      tabIndex={-1}
                    />
                  ),
                )
              : null}

            {view.closures.flatMap((closure) =>
              closure.spans
                .filter(
                  (s) =>
                    s.date === c.date &&
                    (closure.resourceId === null || c.lanes.includes(closure.resourceId)),
                )
                .map((s) => {
                  const lane =
                    closure.resourceId === null ? null : c.lanes.indexOf(closure.resourceId);
                  return (
                    <div
                      key={`${closure.id}-${s.date}`}
                      className="absolute flex items-start justify-center overflow-hidden bg-muted/80 px-1 pt-1 text-center text-xs text-muted-foreground"
                      style={{
                        top: top(Math.max(s.startMinute, from)),
                        height: Math.max(
                          (Math.min(s.endMinute, to) - Math.max(s.startMinute, from)) *
                            PX_PER_MINUTE,
                          0,
                        ),
                        ...laneBox(lane, c.lanes.length),
                        backgroundImage:
                          "repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in oklab, var(--color-border) 70%, transparent) 6px 8px)",
                      }}
                      title={closure.reason ?? "Horario bloqueado"}
                    >
                      {closure.reason ?? "Bloqueado"}
                    </div>
                  );
                }),
            )}

            {view.bookings
              .filter((b) => b.date === c.date && c.lanes.includes(b.resourceId))
              .map((b) => (
                <Link
                  key={b.id}
                  href={bookingsHref({ date: view.date, view: view.view, booking: b.id })}
                  className={cn(
                    "absolute overflow-hidden rounded-md border-l-4 px-1.5 py-0.5 text-xs leading-tight shadow-xs hover:z-20 hover:shadow-md",
                    STATUS_STYLE[b.status] ?? "border-border bg-muted",
                    selected === b.id ? "ring-2 ring-ring" : "",
                  )}
                  style={{
                    top: top(b.startMinute) + 1,
                    height: Math.max((b.endMinute - b.startMinute) * PX_PER_MINUTE - 2, 18),
                    ...laneBox(c.lanes.indexOf(b.resourceId), c.lanes.length),
                  }}
                  title={`${minuteLabel(b.startMinute)} ${b.service} · ${b.subjectName}${c.lanes.length > 1 ? ` · ${String(resourceName.get(b.resourceId))}` : ""} · ${STATUS_LABEL[b.status] ?? b.status}`}
                >
                  <span className="font-medium">{minuteLabel(b.startMinute)}</span> {b.subjectName}
                  <br />
                  <span className="text-muted-foreground">{b.service}</span>
                </Link>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal placement inside a column: the whole width, or one lane of `count`. */
function laneBox(lane: number | null, count: number): CSSProperties {
  if (lane === null || count <= 1) return { left: 2, right: 2 };
  const width = 100 / count;
  return { left: `calc(${String(lane * width)}% + 2px)`, width: `calc(${String(width)}% - 4px)` };
}

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function DayNotes({ view }: { view: BookingsView }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {view.days.map((d) =>
        d.holiday ? (
          <span key={d.date}>
            {view.view === "week" ? `${d.label}: ` : ""}
            <Badge variant={d.holiday.open ? "outline" : "warning"}>
              Festivo · {d.holiday.name} · {d.holiday.open ? "abre" : "cerrado"}
            </Badge>
          </span>
        ) : view.view === "day" ? (
          <span key={d.date}>Horario: {d.hours || "cerrado"}</span>
        ) : null,
      )}
    </div>
  );
}
