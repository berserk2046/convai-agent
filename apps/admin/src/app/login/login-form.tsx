"use client";

import { useActionState } from "react";
import { FormMessage, Submit } from "../../components/form-bits.tsx";
import { Field, Input } from "../../components/ui.tsx";
import { loginAction } from "../auth-actions.ts";

export function LoginForm() {
  const [state, action] = useActionState(loginAction, null);
  return (
    <form action={action} className="grid gap-4">
      <Field label="Correo">
        <Input name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Field label="Contraseña">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <FormMessage state={state} />
      <Submit pendingText="Ingresando…">Ingresar</Submit>
    </form>
  );
}
