"use client";

import { useActionState, useState } from "react";
import { FormMessage, Submit } from "../../../../components/form-bits.tsx";
import { Field, Select, Textarea } from "../../../../components/ui.tsx";
import { consentAction, reenableAction, replyAction, sendTemplateAction } from "../actions.ts";

/**
 * The conversation's forms. `clientId` comes fresh from each server render, so a form
 * submitted twice (double click, retry) sends one message; after a send the page
 * re-renders with a new id.
 */

export function ReplyForm({
  conversationId,
  clientId,
}: {
  conversationId: string;
  clientId: string;
}) {
  const [state, action] = useActionState(replyAction.bind(null, conversationId), null);
  return (
    <form action={action} key={state?.ok ? state.at : undefined} className="grid gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <Textarea
        name="text"
        aria-label="Respuesta"
        placeholder="Escriba su respuesta…"
        maxLength={4096}
        required
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="flex items-center gap-3">
        <Submit pendingText="Enviando…">Enviar</Submit>
        <span className="text-xs text-muted-foreground">Ctrl + Enter para enviar.</span>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export function TemplateForm({
  conversationId,
  clientId,
  templates,
  bookings,
}: {
  conversationId: string;
  clientId: string;
  templates: { key: string; name: string; preview: string; needsBooking: boolean }[];
  bookings: { id: string; label: string; service: string }[];
}) {
  const [state, action] = useActionState(sendTemplateAction.bind(null, conversationId), null);
  const [key, setKey] = useState(templates[0]?.key ?? "");
  const chosen = templates.find((t) => t.key === key);
  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No hay plantillas aprobadas por Meta todavía.</p>
    );
  }
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="clientId" value={clientId} />
      <Field label="Plantilla">
        <Select name="templateKey" value={key} onChange={(e) => setKey(e.target.value)}>
          {templates.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      {chosen?.needsBooking ? (
        <Field label="Cita">
          <Select name="bookingId" defaultValue={bookings[0]?.id ?? ""} required>
            {bookings.length === 0 ? <option value="">No tiene citas próximas</option> : null}
            {bookings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.service} · {b.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {chosen ? (
        <p className="rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
          {chosen.preview}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Submit variant="outline" pendingText="Enviando…">
          Enviar plantilla
        </Submit>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

/** Decision A13: staff record the person's authorization (Ley 1581 de 2012). */
export function ConsentForm({
  conversationId,
  contactId,
}: {
  conversationId: string;
  contactId: string;
}) {
  const [state, action] = useActionState(consentAction.bind(null, conversationId, contactId), null);
  return (
    <form action={action} className="grid gap-2">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" className="mt-1" required />
        <span>El cliente autorizó el tratamiento de sus datos personales.</span>
      </label>
      <div className="flex items-center gap-3">
        <Submit size="sm" variant="outline" pendingText="Guardando…">
          Registrar autorización
        </Submit>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

/** Decision A2: automatic messages again, when the person asks for it (e.g. in person). */
export function ReenableForm({
  conversationId,
  contactId,
}: {
  conversationId: string;
  contactId: string;
}) {
  const [state, action] = useActionState(
    reenableAction.bind(null, conversationId, contactId),
    null,
  );
  return (
    <form action={action} className="grid gap-2">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" className="mt-1" required />
        <span>El cliente pidió volver a recibir recordatorios y mensajes automáticos.</span>
      </label>
      <div className="flex items-center gap-3">
        <Submit size="sm" variant="outline" pendingText="Guardando…">
          Activar de nuevo
        </Submit>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
