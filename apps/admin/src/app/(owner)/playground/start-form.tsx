"use client";

import { useActionState, useState } from "react";
import type { PlaygroundOptions } from "@platform/services";
import { FormMessage, Submit } from "../../../components/form-bits.tsx";
import { Field, Select } from "../../../components/ui.tsx";
import { startAction } from "./actions.ts";

export function StartForm({
  options,
  initialTemplate,
}: {
  options: PlaygroundOptions;
  initialTemplate: string | null;
}) {
  const [state, action] = useActionState(startAction, null);
  const values = options.templates.map((t) => `${t.slug}@${t.version}`);
  const [template, setTemplate] = useState(
    initialTemplate && values.includes(initialTemplate) ? initialTemplate : (values.at(-1) ?? ""),
  );
  const slug = template.slice(0, template.lastIndexOf("@"));
  // A business's config is checked against the chosen version when the session starts.
  const businesses = options.businesses.filter(
    (b) => b.configured && b.template.startsWith(`${slug}@`),
  );
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Template version" hint="The version's agent model answers the chat.">
          <Select
            name="template"
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
            }}
            required
          >
            {options.templates.map((t) => (
              <option key={`${t.slug}@${t.version}`} value={`${t.slug}@${t.version}`}>
                {t.name} {t.version} ({t.status}) · {t.model}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Business data"
          hint="A business's config, resources and closures are copied into the sandbox; its bookings and contacts never are."
        >
          <Select name="config" defaultValue="sample">
            <option value="sample">The template&apos;s sample config</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.template})
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="consent" defaultChecked />
        The customer has already accepted the privacy notice (untick to try the consent flow)
      </label>
      <FormMessage state={state} />
      <div>
        <Submit
          disabled={options.unavailable !== null || values.length === 0}
          pendingText="Preparing the sandbox…"
        >
          Start a chat
        </Submit>
      </div>
    </form>
  );
}
