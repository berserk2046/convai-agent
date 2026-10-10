"use client";

import { useActionState } from "react";
import { FormMessage, Submit } from "../../components/form-bits.tsx";
import { Field, Input } from "../../components/ui.tsx";
import { changePasswordAction } from "../auth-actions.ts";

export function PasswordForm() {
  const [state, action] = useActionState(changePasswordAction, null);
  return (
    <form action={action} key={state?.ok ? state.at : undefined} className="grid gap-4">
      <Field label="Contraseña actual">
        <Input name="current" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="Contraseña nueva" hint="Al menos 10 caracteres.">
        <Input name="next" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Field label="Repita la contraseña nueva">
        <Input name="confirm" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <FormMessage state={state} />
      <Submit pendingText="Guardando…">Cambiar contraseña</Submit>
    </form>
  );
}
