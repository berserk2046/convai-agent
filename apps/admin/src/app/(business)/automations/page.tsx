import type { Metadata } from "next";
import { listBusinessAutomations } from "@platform/services";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  PageHeader,
} from "../../../components/ui.tsx";
import { services } from "../../../lib/server.ts";
import { requireBusinessPage } from "../../../lib/session.ts";
import { setEnabledAction } from "./actions.ts";
import { TimingForm } from "./timing-form.tsx";

export const metadata: Metadata = { title: "Mensajes automáticos" };

const META_STATUS: Record<string, string> = {
  APPROVED: "aprobada",
  PENDING: "en revisión",
  REJECTED: "rechazada",
  PAUSED: "pausada",
  DISABLED: "desactivada",
};

export default async function AutomationsPage() {
  const actor = await requireBusinessPage({ adminOnly: true });
  const rules = await listBusinessAutomations(services(), actor);
  return (
    <>
      <PageHeader
        title="Mensajes automáticos"
        description="Recordatorios y seguimientos que salen solos. Nunca se envían a quien pidió no recibir mensajes, ni de noche."
      />
      <div className="grid gap-6">
        {rules.map((rule) => (
          <Card key={rule.key}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {rule.description}
                  {rule.enabled ? (
                    <Badge variant="success">Activo</Badge>
                  ) : (
                    <Badge variant="outline">Apagado</Badge>
                  )}
                  {rule.enabled && rule.message?.blocked ? (
                    <Badge variant="warning">Bloqueado</Badge>
                  ) : null}
                </span>
              }
              description={`${rule.when}. ${rule.does}.`}
              actions={
                <form action={setEnabledAction.bind(null, rule.key, !rule.enabled)}>
                  <Button size="sm" variant={rule.enabled ? "outline" : "default"}>
                    {rule.enabled ? "Apagar" : "Encender"}
                  </Button>
                </form>
              }
            />
            <CardContent className="grid gap-4">
              {rule.message?.blocked && rule.message.meta ? (
                <Alert variant="warning">
                  No se envía todavía: WhatsApp exige que Meta apruebe la plantilla{" "}
                  <span className="font-mono text-xs">{rule.message.meta.name}</span> (
                  {rule.message.meta.status
                    ? (META_STATUS[rule.message.meta.status] ?? rule.message.meta.status)
                    : "sin enviar a Meta"}
                  ). Mientras tanto, este mensaje se omite.
                </Alert>
              ) : null}
              {rule.message ? (
                <div className="grid gap-2">
                  <span className="text-sm font-medium">
                    {rule.message.kind === "staff" ? "Aviso para el equipo" : "Mensaje"}{" "}
                    <span className="font-normal text-muted-foreground">
                      (con datos de ejemplo)
                    </span>
                  </span>
                  <div className="max-w-md rounded-lg rounded-tl-none bg-success/10 px-4 py-3 text-sm whitespace-pre-wrap">
                    {rule.message.preview}
                    {rule.message.buttons.length > 0 ? (
                      <div className="mt-3 grid gap-1 border-t border-border pt-2">
                        {rule.message.buttons.map((b) => (
                          <span key={b} className="text-center text-primary">
                            {b}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {rule.timing.length > 0 ? (
                <TimingForm ruleKey={rule.key} timing={rule.timing} />
              ) : null}
              <p className="text-xs text-muted-foreground">
                Últimos 30 días: {rule.recent.sent} enviados · {rule.recent.skipped} omitidos
                {rule.recent.failed > 0 ? ` · ${String(rule.recent.failed)} con error` : ""}
                {rule.recent.scheduled > 0 ? ` · ${String(rule.recent.scheduled)} programados` : ""}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
