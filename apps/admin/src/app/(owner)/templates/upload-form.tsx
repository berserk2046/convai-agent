"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Submit } from "../../../components/form-bits.tsx";
import { Alert, Field, Input, Table, Td, Th, Textarea } from "../../../components/ui.tsx";
import { uploadAction } from "./actions.ts";

export function UploadForm() {
  const [state, action] = useActionState(uploadAction, null);
  return (
    <form action={action} className="grid gap-4">
      <Field label="Template YAML file">
        <Input type="file" name="file" accept=".yaml,.yml,text/yaml" />
      </Field>
      <Field label="…or paste it">
        <Textarea name="source" rows={6} className="font-mono text-xs" spellCheck={false} />
      </Field>
      <div>
        <Submit pendingText="Validating…">Validate and save as draft</Submit>
      </div>
      {state?.ok === true ? (
        <Alert variant="success">
          Saved {state.slug}@{state.version} as a draft.{" "}
          <Link
            className="font-medium underline"
            href={`/templates/${state.slug}/${state.version}`}
          >
            Review and publish
          </Link>
          {state.warnings.length > 0 ? ` (${String(state.warnings.length)} warnings)` : null}
        </Alert>
      ) : null}
      {state?.ok === false ? (
        <div className="grid gap-3">
          <Alert variant="destructive">
            {state.message ?? `The template has ${String(state.issues.length)} problem(s).`}
          </Alert>
          {state.issues.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>Line</Th>
                  <Th>Path</Th>
                  <Th>Problem</Th>
                </tr>
              </thead>
              <tbody>
                {state.issues.map((issue, i) => (
                  <tr key={i}>
                    <Td className="font-mono text-xs">{issue.line ?? "—"}</Td>
                    <Td className="font-mono text-xs">{issue.path || "(document)"}</Td>
                    <Td>{issue.message}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
