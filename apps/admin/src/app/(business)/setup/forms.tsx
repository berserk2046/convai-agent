"use client";

import { useActionState } from "react";
import { ConfigForm } from "../../../components/config-form.tsx";
import { FormMessage, Submit } from "../../../components/form-bits.tsx";
import { ClosureForm } from "../../../components/closure-form.tsx";
import { Field, Input } from "../../../components/ui.tsx";
import { addClosureAction, addResourceAction, saveConfigAction } from "./actions.ts";

export function SetupForm(props: {
  schema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  config: Record<string, unknown>;
}) {
  return (
    <ConfigForm
      schema={props.schema}
      uiSchema={props.uiSchema}
      initial={props.config}
      submitLabel="Guardar datos del negocio"
      onSave={saveConfigAction}
    />
  );
}

export function AddResourceForm({ label }: { label: string }) {
  const [state, action] = useActionState(addResourceAction, null);
  return (
    <form
      action={action}
      key={state?.ok ? state.at : undefined}
      className="flex flex-wrap items-end gap-3"
    >
      <Field label={`Nuevo: ${label}`} className="w-56">
        <Input name="name" placeholder={`${label} 1`} required />
      </Field>
      <Field label="Capacidad (opcional)" className="w-40">
        <Input name="capacity" type="number" min="1" />
      </Field>
      <Submit pendingText="Agregando…">Agregar</Submit>
      <FormMessage state={state} />
    </form>
  );
}

export function AddClosureForm({ resources }: { resources: { id: string; name: string }[] }) {
  return <ClosureForm action={addClosureAction} resources={resources} />;
}
