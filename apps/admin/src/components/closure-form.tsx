"use client";

import { useActionState } from "react";
import type { ActionState } from "../lib/actions.ts";
import { FormMessage, Submit } from "./form-bits.tsx";
import { Field, Input, Select } from "./ui.tsx";

/** Block time (spec §12): from /setup (admins) and /bookings (staff too). */
export function ClosureForm({
  action: serverAction,
  resources,
  defaults = {},
  compact = false,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  resources: { id: string; name: string }[];
  defaults?: { from?: string; to?: string; resourceId?: string };
  compact?: boolean;
}) {
  const [state, action] = useActionState(serverAction, null);
  return (
    <form action={action} key={state?.ok ? state.at : undefined} className="grid gap-3">
      <div className={compact ? "grid gap-3" : "grid gap-3 sm:grid-cols-4"}>
        <Field label="Desde">
          <Input name="from" type="datetime-local" defaultValue={defaults.from} required />
        </Field>
        <Field label="Hasta">
          <Input name="to" type="datetime-local" defaultValue={defaults.to} required />
        </Field>
        <Field label="Afecta a">
          <Select name="resourceId" defaultValue={defaults.resourceId ?? ""}>
            <option value="">Todo el negocio</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Motivo">
          <Input name="reason" placeholder="Vacaciones, mantenimiento…" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Submit variant="outline" pendingText="Guardando…">
          Bloquear horario
        </Submit>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
