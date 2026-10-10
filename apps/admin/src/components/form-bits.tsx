"use client";

import { useFormStatus } from "react-dom";
import type { ActionState } from "../lib/actions.ts";
import { Button, cn } from "./ui.tsx";
import type { ComponentProps } from "react";

/** A submit button that shows it's working while its form's action runs. */
export function Submit({
  children,
  pendingText,
  ...props
}: ComponentProps<typeof Button> & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending ? (pendingText ?? children) : children}
    </Button>
  );
}

/** The result line of a form: success in green, a problem in red. */
export function FormMessage({ state, className }: { state: ActionState; className?: string }) {
  if (!state?.message) return null;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      className={cn("text-sm", state.ok ? "text-success" : "text-destructive", className)}
    >
      {state.message}
    </p>
  );
}
