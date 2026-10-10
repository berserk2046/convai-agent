"use client";

import Form from "@rjsf/core";
import {
  TranslatableString,
  getUiOptions,
  type ErrorSchema,
  type FieldProps,
  type IconButtonProps,
  type ObjectFieldTemplateProps,
  type RJSFValidationError,
  type SubmitButtonProps,
  type UiSchema,
} from "@rjsf/utils";
import { customizeValidator } from "@rjsf/validator-ajv8";
import { useMemo, useState, useTransition } from "react";
import { issueText } from "../lib/issue-text.ts";
import { Button, Card, CardContent, CardHeader, Input, cn } from "./ui.tsx";

/**
 * The setup form generated from the pinned template's config_schema (spec §10, §12) with
 * RJSF. `x-ui` hints arrive as the uiSchema the service layer builds: sections, order,
 * help, widgets. The server validates again on save (the authority); its errors show next
 * to their fields.
 */

export interface FieldError {
  path: (string | number)[];
  message: string;
}

// Template schemas carry our own annotations (x-ui, x-platform-type): not Ajv keywords.
const validator = customizeValidator({ ajvOptionsOverrides: { strict: false } });

const SPANISH: Partial<Record<TranslatableString, string>> = {
  [TranslatableString.AddButton]: "Agregar",
  [TranslatableString.AddItemButton]: "Agregar",
  [TranslatableString.RemoveButton]: "Quitar",
  [TranslatableString.MoveUpButton]: "Subir",
  [TranslatableString.MoveDownButton]: "Bajar",
  [TranslatableString.CopyButton]: "Copiar",
  [TranslatableString.YesLabel]: "Sí",
  [TranslatableString.NoLabel]: "No",
  [TranslatableString.EmptyArray]: "Todavía no hay ninguno.",
  [TranslatableString.ArrayItemTitle]: "Elemento",
};

export function ConfigForm({
  schema,
  uiSchema,
  initial,
  submitLabel,
  onSave,
}: {
  schema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  initial: Record<string, unknown>;
  submitLabel: string;
  onSave: (
    config: unknown,
  ) => Promise<{ ok: boolean; message: string | null; errors?: FieldError[] }>;
}) {
  const [data, setData] = useState<Record<string, unknown>>(initial);
  const [extraErrors, setExtraErrors] = useState<ErrorSchema | undefined>(undefined);
  const [result, setResult] = useState<{ ok: boolean; message: string | null } | null>(null);
  const [pending, startTransition] = useTransition();
  const templates = useMemo(
    () => ({ ObjectFieldTemplate: Sections, ButtonTemplates: BUTTONS }),
    [],
  );

  return (
    <Form
      className="rjsf grid gap-6"
      schema={schema}
      uiSchema={{ ...uiSchema, "ui:submitButtonOptions": { submitText: submitLabel } }}
      formData={data}
      validator={validator}
      fields={{ weeklyHours: WeeklyHours }}
      templates={templates}
      translateString={(key, params) => {
        const text = SPANISH[key] ?? key;
        return params ? params.reduce((t, p, i) => t.replace(`%${String(i + 1)}`, p), text) : text;
      }}
      transformErrors={spanishErrors}
      extraErrors={extraErrors}
      showErrorList={false}
      noHtml5Validate
      focusOnFirstError
      disabled={pending}
      onChange={(e) => setData(e.formData as Record<string, unknown>)}
      onSubmit={(e) =>
        startTransition(async () => {
          const response = await onSave(e.formData);
          setExtraErrors(toErrorSchema(response.errors ?? []));
          setResult({ ok: response.ok, message: response.message });
        })
      }
    >
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Guardando…" : submitLabel}
        </Button>
        {result?.message ? (
          <span
            role={result.ok ? "status" : "alert"}
            className={cn("text-sm", result.ok ? "text-success" : "text-destructive")}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </Form>
  );
}

/** Server field errors → RJSF's nested error schema. */
function toErrorSchema(errors: readonly FieldError[]): ErrorSchema | undefined {
  if (errors.length === 0) return undefined;
  const root: Record<string, unknown> = {};
  for (const error of errors) {
    let node = root;
    for (const part of error.path) {
      const key = String(part);
      node[key] ??= {};
      node = node[key] as Record<string, unknown>;
    }
    const list = (node.__errors ??= []) as string[];
    list.push(issueText(error.message));
  }
  return root as ErrorSchema;
}

function spanishErrors(errors: RJSFValidationError[]): RJSFValidationError[] {
  // Ajv's `if` error ("must match "then" schema") repeats what the field errors say.
  return errors
    .filter((e) => e.name !== "if")
    .map((e) => ({ ...e, message: issueText(e.message ?? "") }));
}

/** The root object grouped into the sections `x-ui.section` names; nested objects as fieldsets. */
function Sections(props: ObjectFieldTemplateProps) {
  const { properties, uiSchema, title, fieldPathId } = props;
  if (fieldPathId.$id !== "root") {
    return (
      <fieldset className="grid gap-4 rounded-md border border-border p-4">
        {title ? <legend className="px-1">{title}</legend> : null}
        {properties.filter((p) => !p.hidden).map((p) => p.content)}
      </fieldset>
    );
  }
  const groups: { name: string; items: typeof properties }[] = [];
  for (const property of properties) {
    if (property.hidden) continue;
    const options = getUiOptions((uiSchema?.[property.name] ?? {}) as UiSchema);
    const name = typeof options.section === "string" ? options.section : "Otros datos";
    const group = groups.find((g) => g.name === name);
    if (group) group.items.push(property);
    else groups.push({ name, items: [property] });
  }
  return (
    <div className="grid gap-6">
      {groups.map((group) => (
        <Card key={group.name}>
          <CardHeader title={group.name} />
          <CardContent className="grid gap-5">{group.items.map((p) => p.content)}</CardContent>
        </Card>
      ))}
    </div>
  );
}

const DAYS: [string, string][] = [
  ["mon", "Lunes"],
  ["tue", "Martes"],
  ["wed", "Miércoles"],
  ["thu", "Jueves"],
  ["fri", "Viernes"],
  ["sat", "Sábado"],
  ["sun", "Domingo"],
];

type Week = Record<string, { open: string; close: string }[]>;

/** platform:weekly_hours: each day's opening ranges ("ui:field": "weeklyHours"). */
function WeeklyHours(props: FieldProps) {
  const week = (props.formData ?? {}) as Week;
  const errors = props.errorSchema as Record<string, unknown> | undefined;
  const change = (day: string, ranges: { open: string; close: string }[]) =>
    props.onChange({ ...week, [day]: ranges }, props.fieldPathId.path);
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">{props.schema.title ?? props.name}</span>
      <div className="grid gap-2 rounded-md border border-border p-3">
        {DAYS.map(([key, label]) => {
          const ranges = week[key] ?? [];
          const dayErrors = collect(errors?.[key]);
          return (
            <div key={key} className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-sm">{label}</span>
                {ranges.length === 0 ? (
                  <span className="text-sm text-muted-foreground">Cerrado</span>
                ) : null}
                {ranges.map((range, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <Input
                      type="time"
                      aria-label={`${label}: abre`}
                      className="h-8 w-28"
                      value={range.open}
                      disabled={props.disabled}
                      onChange={(e) =>
                        change(
                          key,
                          ranges.map((r, j) => (j === i ? { ...r, open: e.target.value } : r)),
                        )
                      }
                    />
                    <span className="text-xs text-muted-foreground">a</span>
                    <Input
                      type="time"
                      aria-label={`${label}: cierra`}
                      className="h-8 w-28"
                      value={range.close}
                      disabled={props.disabled}
                      onChange={(e) =>
                        change(
                          key,
                          ranges.map((r, j) => (j === i ? { ...r, close: e.target.value } : r)),
                        )
                      }
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`${label}: quitar horario`}
                      disabled={props.disabled}
                      onClick={() =>
                        change(
                          key,
                          ranges.filter((_, j) => j !== i),
                        )
                      }
                    >
                      ✕
                    </Button>
                  </span>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={props.disabled}
                  onClick={() => {
                    const last = ranges.at(-1);
                    change(key, [
                      ...ranges,
                      last
                        ? { open: last.close, close: "18:00" }
                        : { open: "08:00", close: "12:00" },
                    ]);
                  }}
                >
                  + Horario
                </Button>
              </div>
              {dayErrors.map((message, i) => (
                <span key={i} className="text-xs text-destructive">
                  {message}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Every error message anywhere under an error schema node. */
function collect(node: unknown): string[] {
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "__errors" && Array.isArray(value) ? (value as string[]) : collect(value),
  );
}

function TextButton({ children, ...props }: IconButtonProps & { children: string }) {
  const { className, disabled, onClick, title } = props;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={className}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  );
}

const BUTTONS = {
  AddButton: (props: IconButtonProps) => <TextButton {...props}>+ Agregar</TextButton>,
  RemoveButton: (props: IconButtonProps) => <TextButton {...props}>Quitar</TextButton>,
  MoveUpButton: (props: IconButtonProps) => <TextButton {...props}>↑</TextButton>,
  MoveDownButton: (props: IconButtonProps) => <TextButton {...props}>↓</TextButton>,
  CopyButton: (props: IconButtonProps) => <TextButton {...props}>Copiar</TextButton>,
  // The form's own submit row (with its result) replaces RJSF's button.
  SubmitButton: (_props: SubmitButtonProps) => null,
};
