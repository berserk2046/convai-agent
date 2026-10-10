"use client";

import { useActionState } from "react";
import { FormMessage, Submit } from "../../../../components/form-bits.tsx";
import { Field, Input, Select } from "../../../../components/ui.tsx";
import { createBusinessAction } from "../actions.ts";

export function NewBusinessForm({
  templates,
}: {
  templates: { slug: string; name: string; version: string }[];
}) {
  const [state, action] = useActionState(createBusinessAction, null);
  return (
    <form action={action} className="grid max-w-xl gap-4">
      <Field label="Name" error={state?.fields?.name}>
        <Input name="name" required />
      </Field>
      <Field label="Template">
        <Select name="template" required>
          {templates.map((t) => (
            <option key={`${t.slug}@${t.version}`} value={`${t.slug}@${t.version}`}>
              {t.name} — {t.slug}@{t.version}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Timezone" error={state?.fields?.timezone}>
        <Input name="timezone" defaultValue="America/Bogota" required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Monthly AI cap (USD)"
          hint="Empty: the platform default"
          error={state?.fields?.["limits.llm_usd_month"]}
        >
          <Input name="llmUsdMonth" type="number" min="0" step="0.01" />
        </Field>
        <Field
          label="Monthly marketing messages"
          hint="Empty: the platform default"
          error={state?.fields?.["limits.marketing_msgs_month"]}
        >
          <Input name="marketingMsgsMonth" type="number" min="0" step="1" />
        </Field>
      </div>
      <FormMessage state={state} />
      <div>
        <Submit pendingText="Creating…">Create business</Submit>
      </div>
    </form>
  );
}
