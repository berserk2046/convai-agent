import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { NotFoundError, getConversationView, type ThreadMessage } from "@platform/services";
import { LiveRefresh } from "../../../../components/live-refresh.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  cn,
} from "../../../../components/ui.tsx";
import { shortDateTime } from "../../../../lib/format.ts";
import { isUuid } from "../../../../lib/ids.ts";
import { services } from "../../../../lib/server.ts";
import { requireBusinessPage } from "../../../../lib/session.ts";
import { closeHandoffAction, takeOverAction } from "../actions.ts";
import { reasonLabel, summaryText } from "../labels.ts";
import { ConsentForm, ReenableForm, ReplyForm, TemplateForm } from "./forms.tsx";

export const metadata: Metadata = { title: "Conversación" };

const STATUS: Record<string, string> = {
  queued: "en cola",
  sent: "enviado",
  delivered: "entregado",
  read: "leído",
  failed: "no se pudo enviar",
};

export default async function ConversationPage(props: PageProps<"/inbox/[id]">) {
  const actor = await requireBusinessPage();
  const zone = actor.business?.timezone ?? "America/Bogota";
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const view = await getConversationView(services(), actor, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const { contact, handoff } = view;
  return (
    <>
      <LiveRefresh url="/inbox/events" />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <Link href="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
            ← Bandeja
          </Link>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {contact.title}
            {handoff ? (
              <Badge variant="warning">
                Atiende una persona · {reasonLabel(handoff.reason, handoff.label)}
              </Badge>
            ) : (
              <Badge variant="success">Atiende el asistente</Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">+{contact.waNumber}</p>
        </div>
        {handoff ? (
          <form action={closeHandoffAction.bind(null, view.conversationId)}>
            <Button>Devolver al asistente</Button>
          </form>
        ) : (
          <form action={takeOverAction.bind(null, view.conversationId)}>
            <Button variant="outline">Tomar la conversación</Button>
          </form>
        )}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid gap-4">
          {handoff ? (
            <Alert variant="warning">
              {summaryText(handoff.summary) ?? "El cliente necesita a una persona."} El asistente no
              responde mientras usted atiende. Cuando termine, devuelva la conversación al
              asistente.
            </Alert>
          ) : null}

          <Card>
            <ol
              className="grid max-h-[32rem] gap-3 overflow-y-auto px-5 py-4"
              aria-label="Mensajes"
            >
              {view.messages.length === 0 ? (
                <li className="text-center text-sm text-muted-foreground">Sin mensajes.</li>
              ) : null}
              {view.messages.map((m) => (
                <Bubble key={m.id} message={m} zone={zone} />
              ))}
            </ol>
          </Card>

          <Card>
            <CardHeader
              title="Responder"
              description={
                view.window.open && view.window.closesAt
                  ? `Puede escribir libremente hasta ${shortDateTime(view.window.closesAt, zone)}. Al responder, usted toma la conversación.`
                  : "Pasaron más de 24 horas desde el último mensaje del cliente. WhatsApp solo permite enviarle una plantilla aprobada."
              }
            />
            <CardContent className="grid gap-6">
              {view.window.open ? (
                <ReplyForm conversationId={view.conversationId} clientId={randomUUID()} />
              ) : null}
              <details open={!view.window.open} className="grid gap-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Enviar una plantilla
                </summary>
                <div className="pt-3">
                  <TemplateForm
                    conversationId={view.conversationId}
                    clientId={randomUUID()}
                    templates={view.templates}
                    bookings={view.bookings}
                  />
                </div>
              </details>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4">
          <Card>
            <CardHeader title="Cliente" />
            <CardContent className="grid gap-3 text-sm">
              <dl className="grid gap-2">
                <Item label="Nombre">{contact.name ?? "—"}</Item>
                {contact.profileName ? (
                  <Item label="Nombre en WhatsApp">{contact.profileName}</Item>
                ) : null}
                {contact.fields.map((f) => (
                  <Item key={f.key} label={f.title}>
                    {f.value}
                  </Item>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Datos personales" />
            <CardContent className="grid gap-3 text-sm">
              {contact.consent ? (
                <p>
                  Autorizó el tratamiento de datos el {shortDateTime(contact.consent.at, zone)}
                  {contact.consent.source === "staff" ? " (registrado por el equipo)" : ""}.
                </p>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    Todavía no ha autorizado el tratamiento de sus datos. Sin autorización no recibe
                    mensajes automáticos.
                  </p>
                  <ConsentForm conversationId={view.conversationId} contactId={contact.id} />
                </>
              )}
              {contact.optedOutAt ? (
                <>
                  <p className="border-t border-border pt-3">
                    Pidió no recibir mensajes automáticos el{" "}
                    {shortDateTime(contact.optedOutAt, zone)}.
                  </p>
                  <ReenableForm conversationId={view.conversationId} contactId={contact.id} />
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title="Próximas citas" />
            <CardContent className="text-sm">
              {view.bookings.length === 0 ? (
                <p className="text-muted-foreground">No tiene citas próximas.</p>
              ) : (
                <ul className="grid gap-2">
                  {view.bookings.map((b) => (
                    <li key={b.id}>
                      <span className="font-medium">{b.service}</span>
                      <br />
                      <span className="text-muted-foreground">
                        {b.label}
                        {b.status === "confirmed" ? " · confirmada" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

const AUTHOR: Record<ThreadMessage["author"], string> = {
  customer: "Cliente",
  agent: "Asistente",
  auto: "Mensaje automático",
  staff: "Equipo",
};

function Bubble({ message, zone }: { message: ThreadMessage; zone: string }) {
  const inbound = message.direction === "inbound";
  return (
    <li
      className={cn("grid max-w-[80%] gap-1", inbound ? "justify-self-start" : "justify-self-end")}
    >
      <span className={cn("text-xs text-muted-foreground", inbound ? "" : "text-right")}>
        {message.author === "staff" && message.staffName
          ? message.staffName
          : AUTHOR[message.author]}{" "}
        · {shortDateTime(message.at, zone)}
        {inbound ? "" : ` · ${STATUS[message.status] ?? message.status}`}
      </span>
      <p
        className={cn(
          "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
          inbound ? "rounded-tl-none bg-message-in" : "rounded-tr-none bg-message-out",
          message.status === "failed" ? "ring-1 ring-destructive" : "",
        )}
      >
        {message.body}
      </p>
    </li>
  );
}

function Item({ label, children }: { label: string; children: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
