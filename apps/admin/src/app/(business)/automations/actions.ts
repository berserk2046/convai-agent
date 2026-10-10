"use server";

import { setAutomationEnabled, setAutomationTiming } from "@platform/services";
import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "../../../lib/actions.ts";
import { joinDuration, splitDuration, type DurationUnit } from "../../../lib/duration.ts";
import { services } from "../../../lib/server.ts";
import { requireActor } from "../../../lib/session.ts";
import { field, fieldAll } from "../../../lib/form-data.ts";

/** /automations actions (business admins; the services check the role). */

export async function setEnabledAction(ruleKey: unknown, enabled: unknown): Promise<void> {
  const actor = await requireActor();
  await setAutomationEnabled(services(), actor, String(ruleKey), enabled === true);
  revalidatePath("/automations");
}

/**
 * The timing form posts, per overridable param, either a duration as amount + unit (the
 * sign stays the template's) or a raw value (a time of day, a cron line).
 */
export async function setTimingAction(
  ruleKey: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const actor = await requireActor();
  const overrides: Record<string, string> = {};
  for (const param of fieldAll(form, "param")) {
    if (!form.has(`${param}:amount`)) {
      overrides[param] = field(form, `${param}:value`).trim();
      continue;
    }
    const amount = field(form, `${param}:amount`).trim();
    const n = Number(amount);
    if (amount === "" || !Number.isInteger(n) || n < 0) {
      return { ok: false, message: "Escriba un número entero.", at: Date.now() };
    }
    const template = splitDuration(field(form, `${param}:template`));
    overrides[param] = joinDuration({
      negative: template?.negative ?? false,
      amount: n,
      unit: (field(form, `${param}:unit`) || "h") as DurationUnit,
    });
  }
  const state = await attempt(() => setAutomationTiming(services(), actor, ruleKey, overrides), {
    ok: "Guardado.",
  });
  revalidatePath("/automations");
  // The engine validates in English (Zod); business users get one plain sentence.
  return state?.fields
    ? { ok: false, message: "Ese valor no es válido para este mensaje.", at: state.at }
    : state;
}
