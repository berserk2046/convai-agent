"use server";

import {
  addClosure,
  addResource,
  editResource,
  removeClosure,
  saveConfig,
  setHoliday,
} from "@platform/services";
import { revalidatePath } from "next/cache";
import { attempt, failure, type ActionState } from "../../../lib/actions.ts";
import { services } from "../../../lib/server.ts";
import { requireActor } from "../../../lib/session.ts";
import { field } from "../../../lib/form-data.ts";

/** /setup actions; the services check the role (admins) and scope to the session's business. */

export async function saveConfigAction(config: unknown): Promise<{
  ok: boolean;
  message: string | null;
  errors?: { path: (string | number)[]; message: string }[];
}> {
  const actor = await requireActor();
  try {
    const result = await saveConfig(services(), actor, config);
    revalidatePath("/setup");
    return result.ok
      ? { ok: true, message: "Cambios guardados." }
      : { ok: false, message: "Revise los campos marcados.", errors: result.errors };
  } catch (error) {
    return failure(error);
  }
}

export async function addResourceAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const capacity = field(form, "capacity").trim();
  const state = await attempt(() =>
    addResource(services(), actor, {
      name: field(form, "name"),
      capacity: capacity === "" ? null : Number(capacity),
    }),
  );
  revalidatePath("/setup");
  return state;
}

export async function renameResourceAction(resourceId: string, form: FormData): Promise<void> {
  const actor = await requireActor();
  await editResource(services(), actor, resourceId, { name: field(form, "name") });
  revalidatePath("/setup");
}

// Bound arguments come back from the browser, so they're checked rather than trusted.
export async function toggleResourceAction(resourceId: string, active: unknown): Promise<void> {
  const actor = await requireActor();
  await editResource(services(), actor, resourceId, { active: active === true });
  revalidatePath("/setup");
}

export async function addClosureAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireActor();
  const resourceId = field(form, "resourceId");
  const state = await attempt(
    () =>
      addClosure(services(), actor, {
        resourceId: resourceId === "" ? null : resourceId,
        from: field(form, "from"),
        to: field(form, "to"),
        reason: field(form, "reason"),
      }),
    { ok: "Horario bloqueado." },
  );
  revalidatePath("/setup");
  revalidatePath("/bookings");
  return state;
}

export async function removeClosureAction(closureId: string): Promise<void> {
  const actor = await requireActor();
  await removeClosure(services(), actor, closureId);
  revalidatePath("/setup");
  revalidatePath("/bookings");
}

export async function setHolidayAction(holidayKey: unknown, open: unknown): Promise<void> {
  const actor = await requireActor();
  await setHoliday(services(), actor, String(holidayKey), open === true);
  revalidatePath("/setup");
}
