"use client";

import { useActionState, useEffect, useRef } from "react";
import { FormMessage, Submit } from "../../../../components/form-bits.tsx";
import { Textarea } from "../../../../components/ui.tsx";
import { sayAction } from "../actions.ts";

/** The customer's message box: Enter sends, Shift+Enter adds a line. */
export function Composer({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [state, action] = useActionState(sayAction.bind(null, sessionId), null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    document.getElementById("transcript-end")?.scrollIntoView({ block: "end" });
  }, [state]);
  return (
    <form ref={form} action={action} key={state?.ok ? state.at : undefined} className="grid gap-2">
      <Textarea
        name="message"
        aria-label="Message as the customer"
        placeholder="Write as the customer, e.g. ¿Cuánto vale una limpieza?"
        disabled={disabled}
        required
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            form.current?.requestSubmit();
          }
        }}
      />
      <FormMessage state={state?.ok ? null : state} />
      <div>
        <Submit disabled={disabled} pendingText="Waiting for the agent…">
          Send
        </Submit>
      </div>
    </form>
  );
}
