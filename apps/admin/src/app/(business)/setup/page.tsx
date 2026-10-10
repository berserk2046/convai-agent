import type { Metadata } from "next";
import { getSetup } from "@platform/services";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Empty,
  Input,
  PageHeader,
  Table,
  Td,
  Th,
} from "../../../components/ui.tsx";
import { services } from "../../../lib/server.ts";
import { requireBusinessPage } from "../../../lib/session.ts";
import {
  removeClosureAction,
  renameResourceAction,
  setHolidayAction,
  toggleResourceAction,
} from "./actions.ts";
import { AddClosureForm, AddResourceForm, SetupForm } from "./forms.tsx";

export const metadata: Metadata = { title: "Configuración" };

export default async function SetupPage() {
  const actor = await requireBusinessPage({ adminOnly: true });
  const setup = await getSetup(services(), actor);
  const label = setup.resourceType?.label ?? "Recurso";
  return (
    <>
      <PageHeader
        title="Configuración"
        description="Lo que el asistente sabe del negocio: datos, horario, servicios y precios. Solo responde con esta información."
      />
      <div className="grid gap-8">
        <SetupForm
          schema={setup.form.schema}
          uiSchema={setup.form.uiSchema}
          config={setup.form.config}
        />

        {setup.resourceType ? (
          <Card>
            <CardHeader
              title={`${label}s`}
              description={`Las citas se agendan en un ${label.toLowerCase()} libre. Desactive uno para que no se usen más citas en él.`}
            />
            {setup.resources.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Nombre</Th>
                    <Th>Estado</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {setup.resources.map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <form action={renameResourceAction.bind(null, r.id)} className="flex gap-2">
                          <Input
                            name="name"
                            defaultValue={r.name}
                            className="h-8 w-56"
                            aria-label="Nombre"
                          />
                          <Button size="sm" variant="ghost">
                            Renombrar
                          </Button>
                        </form>
                      </Td>
                      <Td>
                        {r.active ? (
                          <Badge variant="success">Activo</Badge>
                        ) : (
                          <Badge variant="outline">Inactivo</Badge>
                        )}
                      </Td>
                      <Td>
                        <form action={toggleResourceAction.bind(null, r.id, !r.active)}>
                          <Button size="sm" variant="outline">
                            {r.active ? "Desactivar" : "Activar"}
                          </Button>
                        </form>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <Empty>Todavía no hay ninguno. Agregue al menos uno para poder agendar.</Empty>
            )}
            <CardContent className="border-t border-border">
              <AddResourceForm label={label} />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title="Horarios bloqueados"
            description="Vacaciones, un sillón en reparación… En esas horas no se ofrecen citas."
          />
          {setup.closures.length > 0 ? (
            <Table>
              <thead>
                <tr>
                  <Th>Desde</Th>
                  <Th>Hasta</Th>
                  <Th>Afecta a</Th>
                  <Th>Motivo</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {setup.closures.map((c) => (
                  <tr key={c.id}>
                    <Td>{c.from}</Td>
                    <Td>{c.to}</Td>
                    <Td>{c.resourceName ?? "Todo el negocio"}</Td>
                    <Td>{c.reason ?? "—"}</Td>
                    <Td>
                      <form action={removeClosureAction.bind(null, c.id)}>
                        <Button size="sm" variant="ghost">
                          Quitar
                        </Button>
                      </form>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <Empty>No hay horarios bloqueados.</Empty>
          )}
          <CardContent className="border-t border-border">
            <AddClosureForm resources={setup.resources.filter((r) => r.active)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader
            title="Festivos"
            description="Los festivos de Colombia cierran el negocio. Si abre en alguno, actívelo: queda abierto todos los años, con el horario normal de ese día."
          />
          <Table>
            <thead>
              <tr>
                <Th>Festivo</Th>
                <Th>Próxima fecha</Th>
                <Th>¿Abre?</Th>
              </tr>
            </thead>
            <tbody>
              {setup.holidays.map((h) => (
                <tr key={h.key}>
                  <Td>{h.name}</Td>
                  <Td className="text-muted-foreground">{h.next ?? "—"}</Td>
                  <Td>
                    <form
                      action={setHolidayAction.bind(null, h.key, !h.open)}
                      className="flex items-center gap-3"
                    >
                      {h.open ? (
                        <Badge variant="success">Abre</Badge>
                      ) : (
                        <Badge variant="outline">Cerrado</Badge>
                      )}
                      <Button size="sm" variant="ghost">
                        {h.open ? "Cerrar ese día" : "Abrir ese día"}
                      </Button>
                    </form>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Mensaje de consentimiento"
            description="Lo recibe cada cliente la primera vez que escribe (Ley 1581 de 2012). El enlace a la política de datos sale de la configuración."
          />
          <CardContent>
            {setup.consentPreview ? (
              <p className="max-w-2xl rounded-md bg-muted px-4 py-3 text-sm whitespace-pre-wrap">
                {setup.consentPreview}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Guarde los datos del negocio para verlo.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
