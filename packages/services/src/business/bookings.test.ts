import {
  bookings,
  contacts,
  createClosure,
  createResource,
  updateBusinessHolidays,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../actor.ts";
import { ActionRefusedError, NotFoundError } from "../errors.ts";
import { createHarness, type Harness } from "../harness.ts";
import {
  bookingsView,
  cancelStaffBooking,
  confirmStaffBooking,
  createStaffBooking,
  findContacts,
  markNoShow,
  moveStaffBooking,
} from "./bookings.ts";

let h: Harness;
let staff: Actor;
let chair1: string;
let chair2: string;

beforeAll(async () => {
  h = await createHarness();
  staff = await h.actor("staff@a.co", { business: h.a, role: "business_staff" });
  chair1 = (
    await createResource(h.deps.db, { businessId: h.a.id, kind: "chair", name: "Sillón 1" })
  ).id;
  chair2 = (
    await createResource(h.deps.db, { businessId: h.a.id, kind: "chair", name: "Sillón 2" })
  ).id;
  h.setClock("2026-11-09T09:00:00-05:00"); // a Monday
});

afterAll(async () => {
  await h.close();
});

const newPatient = (waNumber: string, name = "Laura Gómez") => ({
  newContact: { waNumber, name, consent: true },
});

describe("creating bookings from the admin", () => {
  it("registers a new patient (with consent, A13) and books the first free resource", async () => {
    const { bookingId } = await createStaffBooking(h.deps, staff, {
      ...newPatient("300 555 0001"),
      serviceKey: "limpieza",
      startsAt: "2026-11-10T10:00",
    });
    const [row] = await h.deps.db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row).toMatchObject({
      resourceId: chair1,
      source: "staff",
      subjectName: "Laura Gómez",
      serviceName: "Limpieza dental",
      priceCop: 120000,
      status: "pending",
    });
    expect((row?.endsAt.getTime() ?? 0) - (row?.startsAt.getTime() ?? 0)).toBe(45 * 60_000);
    const [patient] = await h.deps.db
      .select()
      .from(contacts)
      .where(eq(contacts.waNumber, "573005550001"));
    expect(patient).toMatchObject({ name: "Laura Gómez", consentSource: "staff" });
  });

  it("needs the consent checkbox and a valid number for a new patient", async () => {
    const base = { serviceKey: "limpieza", startsAt: "2026-11-10T11:00" };
    await expect(
      createStaffBooking(h.deps, staff, {
        ...base,
        newContact: { waNumber: "300 555 0002", name: "X Y", consent: false },
      }),
    ).rejects.toMatchObject({ code: "consent_required" });
    await expect(
      createStaffBooking(h.deps, staff, { ...base, ...newPatient("123") }),
    ).rejects.toMatchObject({ code: "bad_number" });
  });

  it("uses the other chair when one is taken, and refuses when both are", async () => {
    const second = await createStaffBooking(h.deps, staff, {
      ...newPatient("300 555 0003", "Pedro Ruiz"),
      serviceKey: "limpieza",
      startsAt: "2026-11-10T10:00",
    });
    const [row] = await h.deps.db.select().from(bookings).where(eq(bookings.id, second.bookingId));
    expect(row?.resourceId).toBe(chair2);
    await expect(
      createStaffBooking(h.deps, staff, {
        ...newPatient("300 555 0004", "Ana Pérez"),
        serviceKey: "limpieza",
        startsAt: "2026-11-10T10:15",
      }),
    ).rejects.toMatchObject({ code: "slot_taken" });
    await expect(
      createStaffBooking(h.deps, staff, {
        ...newPatient("300 555 0004", "Ana Pérez"),
        serviceKey: "limpieza",
        startsAt: "2026-11-10T10:15",
        resourceId: chair1,
      }),
    ).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("finds existing patients by name or number", async () => {
    expect((await findContacts(h.deps, staff, "pedro")).map((c) => c.waNumber)).toEqual([
      "573005550003",
    ]);
    expect((await findContacts(h.deps, staff, "55500")).length).toBeGreaterThanOrEqual(2);
    expect(await findContacts(h.deps, staff, "x")).toEqual([]);
  });
});

describe("the day and week views", () => {
  it("lays bookings, closures and holidays on the grid", async () => {
    await createClosure(h.deps.db, {
      businessId: h.a.id,
      resourceId: chair2,
      startsAt: new Date("2026-11-10T13:00:00-05:00"),
      endsAt: new Date("2026-11-10T15:00:00-05:00"),
      reason: "Mantenimiento",
    });
    const day = await bookingsView(h.deps, staff, { date: "2026-11-10" });
    expect(day).toMatchObject({
      view: "day",
      date: "2026-11-10",
      previous: "2026-11-09",
      next: "2026-11-11",
      days: [
        {
          label: "martes 10 de noviembre",
          hours: "8:00 a. m. a 12:00 m. y 1:00 p. m. a 6:00 p. m.",
          holiday: null,
        },
      ],
      resources: [{ name: "Sillón 1" }, { name: "Sillón 2" }],
      grid: { from: 480, to: 1080 },
      resourceLabel: "Sillón",
    });
    expect(day.bookings.map((b) => [b.startMinute, b.endMinute, b.who, b.source])).toEqual([
      [600, 645, "Laura Gómez", "staff"],
      [600, 645, "Pedro Ruiz", "staff"],
    ]);
    expect(day.closures[0]).toMatchObject({
      reason: "Mantenimiento",
      spans: [{ date: "2026-11-10", startMinute: 780, endMinute: 900 }],
    });

    const week = await bookingsView(h.deps, staff, { date: "2026-11-12", view: "week" });
    expect(week.days.map((d) => d.date)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    const holidayWeek = await bookingsView(h.deps, staff, { date: "2026-11-16", view: "week" });
    expect(holidayWeek.days[0]?.holiday).toEqual({
      name: "Independencia de Cartagena",
      open: false,
    });
    await updateBusinessHolidays(h.deps.db, h.a.id, {
      open_holidays: ["independencia_de_cartagena"],
    });
    expect((await bookingsView(h.deps, staff, { date: "2026-11-16" })).days[0]?.holiday?.open).toBe(
      true,
    );
  });
});

describe("changing bookings", () => {
  it("moves, confirms, cancels, and marks no-shows only after the start", async () => {
    const { bookingId } = await createStaffBooking(h.deps, staff, {
      ...newPatient("300 555 0010", "Sofía Rojas"),
      serviceKey: "valoracion",
      startsAt: "2026-11-11T09:00",
    });
    await expect(
      moveStaffBooking(h.deps, staff, bookingId, {
        startsAt: "2026-11-10T10:00",
        resourceId: chair1,
      }),
    ).rejects.toMatchObject({ code: "slot_taken" });
    await moveStaffBooking(h.deps, staff, bookingId, { startsAt: "2026-11-11T14:00" });
    await confirmStaffBooking(h.deps, staff, bookingId);
    let [row] = await h.deps.db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row).toMatchObject({
      status: "confirmed",
      startsAt: new Date("2026-11-11T14:00:00-05:00"),
    });
    expect(row?.confirmedAt).not.toBeNull();

    await expect(markNoShow(h.deps, staff, bookingId)).rejects.toMatchObject({ code: "not_yet" });
    h.setClock("2026-11-11T15:00:00-05:00");
    await markNoShow(h.deps, staff, bookingId);
    [row] = await h.deps.db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(row?.status).toBe("no_show");
    await expect(cancelStaffBooking(h.deps, staff, bookingId)).rejects.toBeInstanceOf(
      ActionRefusedError,
    );
    h.setClock("2026-11-09T09:00:00-05:00");
  });

  it("never touches another business's bookings", async () => {
    const { bookingId } = await createStaffBooking(h.deps, staff, {
      ...newPatient("300 555 0020", "Inés Mora"),
      serviceKey: "limpieza",
      startsAt: "2026-11-12T09:00",
    });
    const other = await h.actor("staff@b.co", { business: h.b, role: "business_staff" });
    await expect(cancelStaffBooking(h.deps, other, bookingId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      moveStaffBooking(h.deps, other, bookingId, { startsAt: "2026-11-12T10:00" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createStaffBooking(h.deps, other, {
        serviceKey: "limpieza",
        startsAt: "2026-11-12T09:00",
        resourceId: chair1,
        ...newPatient("300 555 0021"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await bookingsView(h.deps, other, { date: "2026-11-12" })).bookings).toEqual([]);
  });
});
