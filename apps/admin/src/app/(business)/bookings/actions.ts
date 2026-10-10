"use server";

import {
  addClosure,
  cancelStaffBooking,
  confirmStaffBooking,
  createStaffBooking,
  findContacts,
  markNoShow,
  moveStaffBooking,
} from "@platform/services";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, failure, type ActionState } from "../../../lib/actions.ts";
import { services } from "../../../lib/server.ts";
import { requireActor } from "../../../lib/session.ts";
import { field } from "../../../lib/form-data.ts";

/** /bookings actions: staff and admins. The exclusion constraint still guards every write. */

function text(form: FormData, name: string): string {
  return field(form, name).trim();
}

export async function createBookingAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const startsAt = text(form, "startsAt");
  const contactId = text(form, "contactId");
  let bookingId: string;
  try {
    ({ bookingId } = await createStaffBooking(services(), actor, {
      contactId: contactId === "" ? null : contactId,
      newContact:
        contactId === ""
          ? {
              waNumber: text(form, "waNumber"),
              name: text(form, "name"),
              consent: form.get("consent") === "on",
            }
          : null,
      serviceKey: text(form, "serviceKey"),
      startsAt,
      resourceId: text(form, "resourceId") || null,
      subjectName: text(form, "subjectName") || null,
      notes: text(form, "notes") || null,
    }));
  } catch (error) {
    return { ...failure(error), at: Date.now() };
  }
  revalidatePath("/bookings");
  redirect(`/bookings?date=${startsAt.slice(0, 10)}&booking=${bookingId}`);
}

export async function bookingStatusAction(
  bookingId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const op = field(form, "op");
  const work = {
    confirm: { run: confirmStaffBooking, ok: "Cita confirmada." },
    cancel: { run: cancelStaffBooking, ok: "Cita cancelada." },
    no_show: { run: markNoShow, ok: "Marcada como no asistió." },
  }[op];
  if (!work) return { ok: false, message: "Acción no válida.", at: Date.now() };
  const state = await attempt(() => work.run(services(), actor, bookingId), { ok: work.ok });
  revalidatePath("/bookings");
  return state;
}

export async function moveBookingAction(
  bookingId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const startsAt = text(form, "startsAt");
  const state = await attempt(
    () =>
      moveStaffBooking(services(), actor, bookingId, {
        startsAt,
        resourceId: text(form, "resourceId") || null,
      }),
    { ok: "Cita movida." },
  );
  if (state?.ok) {
    revalidatePath("/bookings");
    redirect(`/bookings?date=${startsAt.slice(0, 10)}&booking=${bookingId}`);
  }
  return state;
}

export async function blockTimeAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const state = await attempt(
    () =>
      addClosure(services(), actor, {
        resourceId: text(form, "resourceId") || null,
        from: text(form, "from"),
        to: text(form, "to"),
        reason: text(form, "reason"),
      }),
    { ok: "Horario bloqueado." },
  );
  revalidatePath("/bookings");
  revalidatePath("/setup");
  return state;
}

/** Contact search for the new-booking form (name or number). */
export async function searchContactsAction(
  query: unknown,
): Promise<{ id: string; title: string; waNumber: string }[]> {
  const actor = await requireActor();
  return findContacts(services(), actor, String(query).slice(0, 100));
}
