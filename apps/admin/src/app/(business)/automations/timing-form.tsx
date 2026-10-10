"use client";

import { useActionState } from "react";
import { FormMessage, Submit } from "../../../components/form-bits.tsx";
import { Input, Select } from "../../../components/ui.tsx";
import { DURATION_UNITS, splitDuration } from "../../../lib/duration.ts";
import { setTimingAction } from "./actions.ts";

export interface Timing {
  param: string;
  value: string;
  templateValue: string;
  label: string;
}

/** The trigger params the template lets the business change (`overridable`). */
export function TimingForm({ ruleKey, timing }: { ruleKey: string; timing: Timing[] }) {
  const [state, action] = useActionState(setTimingAction.bind(null, ruleKey), null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-4">
      {timing.map((t) => (
        <TimingInput key={t.param} timing={t} />
      ))}
      <Submit size="sm" variant="outline" pendingText="Guardando…">
        Guardar
      </Submit>
      <FormMessage state={state} />
    </form>
  );
}

function TimingInput({ timing }: { timing: Timing }) {
  const template = splitDuration(timing.templateValue);
  const current = splitDuration(timing.value) ?? template;
  const changed = timing.value !== timing.templateValue;
  const hint = changed ? (
    <span className="text-xs text-muted-foreground">Plantilla: {timing.templateValue}</span>
  ) : null;
  return (
    <div className="grid gap-1.5">
      <input type="hidden" name="param" value={timing.param} />
      <span className="text-sm font-medium">{timing.label}</span>
      {template && current ? (
        <span className="flex items-center gap-2">
          <input type="hidden" name={`${timing.param}:template`} value={timing.templateValue} />
          <Input
            name={`${timing.param}:amount`}
            type="number"
            min="0"
            step="1"
            defaultValue={current.amount}
            className="h-8 w-24"
            aria-label={`${timing.label}: cantidad`}
          />
          <Select
            name={`${timing.param}:unit`}
            defaultValue={current.unit}
            className="h-8 w-28"
            aria-label={`${timing.label}: unidad`}
          >
            {DURATION_UNITS.map((u) => (
              <option key={u.unit} value={u.unit}>
                {u.label}
              </option>
            ))}
          </Select>
          {template.negative ? <span className="text-sm text-muted-foreground">antes</span> : null}
        </span>
      ) : (
        <Input
          name={`${timing.param}:value`}
          type={/^\d{2}:\d{2}$/.test(timing.templateValue) ? "time" : "text"}
          defaultValue={timing.value}
          className="h-8 w-36"
          aria-label={timing.label}
        />
      )}
      {hint}
    </div>
  );
}
