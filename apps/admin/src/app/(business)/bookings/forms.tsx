"use client";

import { useActionState, useEffect, useState } from "react";
import { FormMessage, Submit } from "../../../components/form-bits.tsx";
import { Button, Field, Input, Select, Textarea } from "../../../components/ui.tsx";
import {
  bookingStatusAction,
  createBookingAction,
  moveBookingAction,
  searchContactsAction,
} from "./actions.ts";

type Option = { id: string; name: string };

export function NewBookingForm({
  services,
  resources,
  resourceLabel,
  defaults,
}: {
  services: { key: string; name: string; durationMin: number | null }[];
  resources: Option[];
  resourceLabel: string;
  defaults: { startsAt: string; resourceId: string };
}) {
  const [state, action] = useActionState(createBookingAction, null);
  const [contact, setContact] = useState<{ id: string; title: string } | null>(null);
  const [isNew, setIsNew] = useState(false);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="contactId" value={contact?.id ?? ""} />
      {contact ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <span>{contact.title}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setContact(null)}>
            Cambiar
          </Button>
        </div>
      ) : isNew ? (
        <fieldset className="grid gap-3 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">Cliente nuevo</legend>
          <Field label="Celular (WhatsApp)">
            <Input name="waNumber" type="tel" placeholder="300 123 4567" required />
          </Field>
          <Field label="Nombre">
            <Input name="name" required />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" className="mt-1" required />
            <span>El cliente autorizó el tratamiento de sus datos personales.</span>
          </label>
          <Button type="button" size="sm" variant="ghost" onClick={() => setIsNew(false)}>
            Buscar un cliente existente
          </Button>
        </fieldset>
      ) : (
        <ContactSearch onPick={setContact} onNew={() => setIsNew(true)} />
      )}
      <Field label="Servicio">
        <Select name="serviceKey" required defaultValue="">
          <option value="" disabled>
            Elija un servicio
          </option>
          {services.map((s) => (
            <option key={s.key} value={s.key} disabled={!s.durationMin}>
              {s.name}
              {s.durationMin ? ` (${String(s.durationMin)} min)` : " (sin duración)"}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Fecha y hora">
        <Input
          name="startsAt"
          type="datetime-local"
          step={300}
          defaultValue={defaults.startsAt}
          required
        />
      </Field>
      <Field label={resourceLabel}>
        <Select name="resourceId" defaultValue={defaults.resourceId}>
          <option value="">El primero libre</option>
          {resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Quién asiste"
        hint="Si es otra persona (por ejemplo, un hijo). Por defecto, el cliente."
      >
        <Input name="subjectName" />
      </Field>
      <Field label="Notas">
        <Textarea name="notes" maxLength={1000} />
      </Field>
      <div className="flex items-center gap-3">
        <Submit pendingText="Agendando…">Agendar</Submit>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

function ContactSearch({
  onPick,
  onNew,
}: {
  onPick: (contact: { id: string; title: string }) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; title: string; waNumber: string }[]>([]);
  useEffect(() => {
    if (query.trim().length < 2) return;
    let current = true;
    const timer = setTimeout(() => {
      void searchContactsAction(query).then((found) => {
        if (current) setResults(found);
      });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);
  const shown = query.trim().length < 2 ? [] : results;
  return (
    <div className="grid gap-2">
      <Field label="Cliente">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Nombre o celular"
          autoComplete="off"
        />
      </Field>
      {shown.length > 0 ? (
        <ul className="grid rounded-md border border-border text-sm">
          {shown.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-muted"
                onClick={() => onPick({ id: c.id, title: `${c.title} · +${c.waNumber}` })}
              >
                {c.title} <span className="text-muted-foreground">+{c.waNumber}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button type="button" size="sm" variant="ghost" onClick={onNew}>
        + Cliente nuevo
      </Button>
    </div>
  );
}

export function BookingActions({ bookingId, status }: { bookingId: string; status: string }) {
  const [state, action] = useActionState(bookingStatusAction.bind(null, bookingId), null);
  const active = status === "pending" || status === "confirmed";
  return (
    <form action={action} className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {status === "pending" ? (
          <Submit size="sm" name="op" value="confirm">
            Confirmar
          </Submit>
        ) : null}
        {active ? (
          <Submit size="sm" variant="outline" name="op" value="no_show">
            No asistió
          </Submit>
        ) : null}
      </div>
      {active ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-destructive">Cancelar la cita</summary>
          <div className="mt-2 grid gap-2">
            <p className="text-muted-foreground">El horario queda libre para otra persona.</p>
            <Submit size="sm" variant="destructive" name="op" value="cancel">
              Sí, cancelar
            </Submit>
          </div>
        </details>
      ) : null}
      <FormMessage state={state} />
    </form>
  );
}

export function MoveForm({
  bookingId,
  startsAt,
  resourceId,
  resources,
  resourceLabel,
}: {
  bookingId: string;
  startsAt: string;
  resourceId: string;
  resources: Option[];
  resourceLabel: string;
}) {
  const [state, action] = useActionState(moveBookingAction.bind(null, bookingId), null);
  return (
    <form action={action} className="grid gap-3">
      <Field label="Nueva fecha y hora">
        <Input name="startsAt" type="datetime-local" step={300} defaultValue={startsAt} required />
      </Field>
      <Field label={resourceLabel}>
        <Select name="resourceId" defaultValue={resourceId}>
          {resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-center gap-3">
        <Submit size="sm" variant="outline" pendingText="Moviendo…">
          Mover
        </Submit>
        <FormMessage state={state} />
      </div>
    </form>
  );
}
