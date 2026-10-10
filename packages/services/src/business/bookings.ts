import {
  SlotTakenError,
  cancelBooking,
  confirmBooking,
  ensureConversation,
  getBooking,
  getContact,
  grantConsent,
  insertBooking,
  listBookingsWithContacts,
  listClosures,
  listResources,
  markBookingNoShow,
  moveBooking,
  searchContacts,
  setContactNameIfMissing,
  upsertContact,
  type BookingRow,
  type ContactRow,
} from "@platform/db";
import { WEEKDAY_KEYS, formatRanges, holidayOn } from "@platform/shared";
import {
  PLATFORM_TYPE_KEYWORD,
  getPath,
  isObject,
  resolveBookingRules,
  type PreparedTemplate,
} from "@platform/templates";
import { DateTime } from "luxon";
import type { Actor } from "../actor.ts";
import type { ServiceDeps } from "../deps.ts";
import { ActionRefusedError, NotFoundError, requireIds } from "../errors.ts";
import { normalizeWaNumber } from "../phone.ts";
import { inBusiness, pinnedTemplate, type Scope } from "../tenancy.ts";
import { dayLabel, parseLocal, slotLabel, toLocalInput } from "../time.ts";

/**
 * /bookings (spec §12): a day or week per resource, and the staff actions — create, move,
 * cancel, confirm, mark no-show. Staff and admins. The exclusion constraint still guards
 * every write (principle 3). Automations pick staff changes up from the bookings' own
 * timestamps (the sweeper), so the admin needs no queue.
 */

export interface BookingsView {
  view: "day" | "week";
  date: string;
  previous: string;
  next: string;
  days: {
    date: string;
    label: string;
    hours: string;
    holiday: { name: string; open: boolean } | null;
  }[];
  resources: { id: string; name: string }[];
  /** Minutes since midnight the grid shows (from the earliest opening to the latest close). */
  grid: { from: number; to: number };
  bookings: {
    id: string;
    resourceId: string;
    date: string;
    startMinute: number;
    endMinute: number;
    label: string;
    startsAt: string;
    service: string;
    subjectName: string;
    who: string;
    waNumber: string;
    conversationId: string | null;
    status: string;
    source: string;
    notes: string | null;
  }[];
  closures: {
    id: string;
    resourceId: string | null;
    from: string;
    to: string;
    reason: string | null;
    /** Per day shown: the blocked minutes. */
    spans: { date: string; startMinute: number; endMinute: number }[];
  }[];
  services: { key: string; name: string; durationMin: number | null }[];
  resourceLabel: string;
}

export async function bookingsView(
  deps: ServiceDeps,
  actor: Actor,
  input: { date?: string; view?: "day" | "week" },
): Promise<BookingsView> {
  return inBusiness(deps, actor, undefined, async (scope) => {
    const { tx, business } = scope;
    const zone = business.timezone;
    const prepared = await pinnedTemplate(scope);
    const view = input.view === "week" ? "week" : "day";
    const today = DateTime.fromJSDate(deps.now(), { zone }).startOf("day");
    const asked = input.date ? DateTime.fromISO(input.date, { zone }) : today;
    const anchor = asked.isValid ? asked.startOf("day") : today;
    const first = view === "week" ? anchor.startOf("week") : anchor;
    const count = view === "week" ? 7 : 1;
    const from = first.toJSDate();
    const to = first.plus({ days: count }).toJSDate();

    const kind = String(prepared.template.booking?.resource_kind ?? "");
    const resources = (await listResources(tx, business.id)).filter(
      (r) => r.active && r.kind === kind,
    );
    const rows = await listBookingsWithContacts(tx, business.id, from, to);
    const closures = await listClosures(tx, business.id, from, to);
    const hours = weeklyHours(prepared, business.config ?? {});
    const days = Array.from({ length: count }, (_, i) => first.plus({ days: i }));
    const open = business.holidays.open_holidays ?? [];

    const minutes = (at: Date) => {
      const local = DateTime.fromJSDate(at, { zone });
      return { date: local.toISODate() ?? "", minute: local.hour * 60 + local.minute };
    };
    const ranges = days.flatMap((d) => hours[WEEKDAY_KEYS[d.weekday - 1] ?? "mon"] ?? []);
    const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
    let gridFrom = Math.min(...ranges.map((r) => toMinute(r.open)), 8 * 60);
    let gridTo = Math.max(...ranges.map((r) => toMinute(r.close)), 18 * 60);
    for (const { booking } of rows) {
      gridFrom = Math.min(gridFrom, minutes(booking.startsAt).minute);
      gridTo = Math.max(gridTo, minutes(booking.endsAt).minute || 24 * 60);
    }

    return {
      view,
      date: anchor.toISODate() ?? "",
      previous: anchor.minus({ days: count }).toISODate() ?? "",
      next: anchor.plus({ days: count }).toISODate() ?? "",
      days: days.map((d) => {
        const date = d.toISODate() ?? "";
        const holiday = holidayOn(date, open);
        return {
          date,
          label: dayLabel(date, zone),
          hours: formatRanges(hours[WEEKDAY_KEYS[d.weekday - 1] ?? "mon"] ?? []),
          holiday: holiday ? { name: holiday.name, open: holiday.open } : null,
        };
      }),
      resources: resources.map((r) => ({ id: r.id, name: r.name })),
      grid: { from: Math.floor(gridFrom / 60) * 60, to: Math.ceil(gridTo / 60) * 60 },
      bookings: rows.map(({ booking, contact, conversationId }) => {
        const start = minutes(booking.startsAt);
        const end = minutes(booking.endsAt);
        return {
          id: booking.id,
          resourceId: booking.resourceId,
          date: start.date,
          startMinute: start.minute,
          endMinute: end.date === start.date ? end.minute : 24 * 60,
          label: slotLabel(booking.startsAt, zone),
          startsAt: toLocalInput(booking.startsAt, zone),
          service: booking.serviceName,
          subjectName: booking.subjectName,
          who: contact.name ?? contact.waProfileName ?? `+${contact.waNumber}`,
          waNumber: contact.waNumber,
          conversationId,
          status: booking.status,
          source: booking.source,
          notes: booking.notes,
        };
      }),
      closures: closures.map((c) => ({
        id: c.id,
        resourceId: c.resourceId,
        from: slotLabel(c.startsAt, zone),
        to: slotLabel(c.endsAt, zone),
        reason: c.reason,
        spans: days.flatMap((d) => {
          const dayStart = d.toMillis();
          const dayEnd = d.plus({ days: 1 }).toMillis();
          const s = Math.max(c.startsAt.getTime(), dayStart);
          const e = Math.min(c.endsAt.getTime(), dayEnd);
          if (s >= e) return [];
          return [
            {
              date: d.toISODate() ?? "",
              startMinute: Math.round((s - dayStart) / 60_000),
              endMinute: Math.round((e - dayStart) / 60_000),
            },
          ];
        }),
      })),
      services: catalog(prepared, business.config ?? {}).map((item) => ({
        key: item.key,
        name: item.name,
        durationMin: item.durationMin,
      })),
      resourceLabel: String(prepared.template.booking?.resource_label ?? "Recurso"),
    };
  });
}

export async function findContacts(
  deps: ServiceDeps,
  actor: Actor,
  query: string,
): Promise<{ id: string; title: string; waNumber: string }[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  return inBusiness(deps, actor, undefined, async ({ tx, business }) =>
    (await searchContacts(tx, business.id, q)).map((c) => ({
      id: c.id,
      title: c.name ?? c.waProfileName ?? `+${c.waNumber}`,
      waNumber: c.waNumber,
    })),
  );
}

export interface NewStaffBooking {
  /** An existing contact… */
  contactId?: string | null;
  /** …or a new one: the person must have authorized data processing (decision A13). */
  newContact?: { waNumber: string; name: string; consent: boolean } | null;
  serviceKey: string;
  /** Local "2026-10-08T15:00". */
  startsAt: string;
  /** A specific resource, or null for the first free one. */
  resourceId?: string | null;
  /** Who attends; defaults to the contact's name. */
  subjectName?: string | null;
  notes?: string | null;
}

export async function createStaffBooking(
  deps: ServiceDeps,
  actor: Actor,
  input: NewStaffBooking,
): Promise<{ bookingId: string }> {
  requireIds("booking", input.contactId, input.resourceId);
  return inBusiness(deps, actor, undefined, async (scope) => {
    const { tx, business } = scope;
    const prepared = await pinnedTemplate(scope);
    const item = catalog(prepared, business.config ?? {}).find((i) => i.key === input.serviceKey);
    if (!item) throw new ActionRefusedError("unknown_service", "Elija un servicio de la lista.");
    const durationMin = item.durationMin;
    if (!durationMin) {
      throw new ActionRefusedError("no_duration", "Ese servicio no tiene duración configurada.");
    }
    const start = parseLocal(input.startsAt, business.timezone);
    if (!start) throw new ActionRefusedError("bad_time", "Elija la fecha y la hora de la cita.");

    const contact = await bookingContact(scope, input, deps.now());
    const subjectName = (input.subjectName ?? contact.name ?? "").trim();
    if (subjectName === "") {
      throw new ActionRefusedError("subject_required", "Escriba el nombre de quien asiste.");
    }
    const candidates = await resourceChoices(scope, prepared, input.resourceId ?? null);
    for (const resourceId of candidates) {
      try {
        const booking = await savepoint(scope, () =>
          insertBooking(tx, {
            businessId: business.id,
            contactId: contact.id,
            resourceId,
            serviceKey: item.key,
            serviceName: item.name,
            priceCop: item.priceCop,
            subjectName,
            partySize: null,
            startsAt: start,
            endsAt: new Date(start.getTime() + durationMin * 60_000),
            source: "staff",
            notes: input.notes?.trim() || null,
          }),
        );
        await ensureConversation(tx, business.id, contact.id);
        await scope.audit("booking.create", {
          booking_id: booking.id,
          service: item.key,
          starts_at: input.startsAt,
          resource_id: resourceId,
        });
        return { bookingId: booking.id };
      } catch (error) {
        if (!(error instanceof SlotTakenError)) throw error;
      }
    }
    throw slotTaken();
  });
}

export async function moveStaffBooking(
  deps: ServiceDeps,
  actor: Actor,
  bookingId: string,
  input: { startsAt: string; resourceId?: string | null },
): Promise<void> {
  requireIds("booking", bookingId, input.resourceId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    const booking = await activeBooking(scope, bookingId);
    const start = parseLocal(input.startsAt, scope.business.timezone);
    if (!start) throw new ActionRefusedError("bad_time", "Elija la nueva fecha y hora.");
    const prepared = await pinnedTemplate(scope);
    const resourceId = input.resourceId ?? booking.resourceId;
    if (!(await resourceChoices(scope, prepared, resourceId)).includes(resourceId)) {
      throw new NotFoundError("resource");
    }
    const length = booking.endsAt.getTime() - booking.startsAt.getTime();
    try {
      await savepoint(scope, () =>
        moveBooking(scope.tx, booking.id, {
          startsAt: start,
          endsAt: new Date(start.getTime() + length),
          resourceId,
        }),
      );
    } catch (error) {
      if (error instanceof SlotTakenError) throw slotTaken();
      throw error;
    }
    await scope.audit("booking.move", {
      booking_id: booking.id,
      starts_at: input.startsAt,
      resource_id: resourceId,
    });
  });
}

export async function cancelStaffBooking(
  deps: ServiceDeps,
  actor: Actor,
  bookingId: string,
): Promise<void> {
  requireIds("booking", bookingId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    const booking = await activeBooking(scope, bookingId);
    await cancelBooking(scope.tx, booking.id);
    await scope.audit("booking.cancel", { booking_id: booking.id });
  });
}

export async function confirmStaffBooking(
  deps: ServiceDeps,
  actor: Actor,
  bookingId: string,
): Promise<void> {
  requireIds("booking", bookingId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    const booking = await activeBooking(scope, bookingId);
    if (booking.status === "pending") await confirmBooking(scope.tx, booking.id);
    await scope.audit("booking.confirm", { booking_id: booking.id });
  });
}

/** Staff mark a no-show once the appointment time has come (spec §8, §12). */
export async function markNoShow(
  deps: ServiceDeps,
  actor: Actor,
  bookingId: string,
): Promise<void> {
  requireIds("booking", bookingId);
  await inBusiness(deps, actor, undefined, async (scope) => {
    const booking = await getBooking(scope.tx, bookingId);
    if (!booking) throw new NotFoundError("booking");
    if (booking.startsAt > deps.now()) {
      throw new ActionRefusedError("not_yet", "La cita todavía no ha empezado.");
    }
    if (!(await markBookingNoShow(scope.tx, booking.id))) {
      throw new ActionRefusedError("not_allowed", "Esa cita está cancelada.");
    }
    await scope.audit("booking.no_show", { booking_id: booking.id });
  });
}

// --- helpers ------------------------------------------------------------------------------------

interface CatalogEntry {
  key: string;
  name: string;
  durationMin: number | null;
  priceCop: number | null;
}

function catalog(prepared: PreparedTemplate, config: Record<string, unknown>): CatalogEntry[] {
  if (!prepared.template.booking) return [];
  const rules = resolveBookingRules(prepared.template.booking, config);
  const items = getPath(config, rules.catalog_path);
  return (Array.isArray(items) ? items.filter(isObject) : []).flatMap((item) =>
    typeof item.key === "string" && typeof item.name === "string"
      ? [
          {
            key: item.key,
            name: item.name,
            durationMin:
              rules.duration_from === "fixed"
                ? (rules.fixed_duration_min as number | null)
                : typeof item.duration_min === "number"
                  ? item.duration_min
                  : null,
            priceCop: typeof item.price_cop === "number" ? item.price_cop : null,
          },
        ]
      : [],
  );
}

/** The business's weekly hours (the first platform:weekly_hours config field). */
function weeklyHours(
  prepared: PreparedTemplate,
  config: Record<string, unknown>,
): Partial<Record<string, { open: string; close: string }[]>> {
  const properties = isObject(prepared.config.schema.properties)
    ? prepared.config.schema.properties
    : {};
  const field = Object.entries(properties).find(
    ([, s]) => isObject(s) && s[PLATFORM_TYPE_KEYWORD] === "weekly_hours",
  )?.[0];
  const hours = field ? config[field] : undefined;
  return isObject(hours)
    ? (hours as Partial<Record<string, { open: string; close: string }[]>>)
    : {};
}

async function bookingContact(
  scope: Scope,
  input: NewStaffBooking,
  now: Date,
): Promise<ContactRow> {
  if (input.contactId) {
    const contact = await getContact(scope.tx, input.contactId);
    if (!contact) throw new NotFoundError("contact");
    return contact;
  }
  const fresh = input.newContact;
  if (!fresh) throw new ActionRefusedError("contact_required", "Elija o registre al cliente.");
  const waNumber = normalizeWaNumber(fresh.waNumber);
  if (!waNumber) {
    throw new ActionRefusedError(
      "bad_number",
      "Escriba un celular válido, por ejemplo 300 123 4567.",
    );
  }
  if (!fresh.consent) {
    throw new ActionRefusedError(
      "consent_required",
      "Confirme que el cliente autorizó el tratamiento de sus datos.",
    );
  }
  const contact = await upsertContact(scope.tx, scope.business.id, waNumber);
  const name = fresh.name.trim();
  if (name !== "") await setContactNameIfMissing(scope.tx, contact.id, name);
  await grantConsent(scope.tx, contact.id, "staff", now);
  await scope.audit("contact.consent", { contact_id: contact.id, via: "booking" });
  return (await getContact(scope.tx, contact.id)) ?? contact;
}

/** The resource asked for (if it's an active one of the template's kind), or all of them. */
async function resourceChoices(
  scope: Scope,
  prepared: PreparedTemplate,
  resourceId: string | null,
): Promise<string[]> {
  const kind = String(prepared.template.booking?.resource_kind ?? "");
  const ids = (await listResources(scope.tx, scope.business.id))
    .filter((r) => r.active && r.kind === kind)
    .map((r) => r.id);
  if (resourceId === null) return ids;
  if (!ids.includes(resourceId)) throw new NotFoundError("resource");
  return [resourceId];
}

async function activeBooking(scope: Scope, bookingId: string): Promise<BookingRow> {
  const booking = await getBooking(scope.tx, bookingId);
  if (!booking) throw new NotFoundError("booking");
  if (booking.status !== "pending" && booking.status !== "confirmed") {
    throw new ActionRefusedError("not_active", "Esa cita ya no está activa.");
  }
  return booking;
}

/**
 * Runs a write that may hit the exclusion constraint inside a savepoint, so the tenant
 * transaction survives a SlotTaken and can try the next resource.
 */
function savepoint<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
  return scope.tx.transaction(() => work());
}

function slotTaken(): ActionRefusedError {
  return new ActionRefusedError(
    "slot_taken",
    "Ese horario ya está ocupado. Elija otra hora u otro recurso.",
  );
}
