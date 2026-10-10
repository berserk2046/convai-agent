import type { Metadata } from "next";
import Link from "next/link";
import { listInbox, listNotifications } from "@platform/services";
import { LiveRefresh } from "../../../components/live-refresh.tsx";
import { Badge, Button, Card, CardHeader, Empty, PageHeader, cn } from "../../../components/ui.tsx";
import { when } from "../../../lib/format.ts";
import { services } from "../../../lib/server.ts";
import { requireBusinessPage } from "../../../lib/session.ts";
import { markAllReadAction, openNotificationAction } from "./actions.ts";
import { reasonLabel, summaryText } from "./labels.ts";

export const metadata: Metadata = { title: "Bandeja" };

export default async function InboxPage(props: PageProps<"/inbox">) {
  const actor = await requireBusinessPage();
  const zone = actor.business?.timezone ?? "America/Bogota";
  const { filter } = await props.searchParams;
  const onlyHandoffs = filter !== "all";
  const [items, notices] = await Promise.all([
    listInbox(services(), actor, { onlyHandoffs }),
    listNotifications(services(), actor, { unreadOnly: true }),
  ]);
  return (
    <>
      <LiveRefresh url="/inbox/events" />
      <PageHeader
        title="Bandeja"
        description="Conversaciones que necesitan a una persona. Mientras una persona atiende, el asistente no responde."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader
            title={onlyHandoffs ? "Esperando a una persona" : "Todas las conversaciones"}
            actions={
              <div className="flex gap-1 text-sm">
                <FilterLink href="/inbox" active={onlyHandoffs}>
                  Esperando
                </FilterLink>
                <FilterLink href="/inbox?filter=all" active={!onlyHandoffs}>
                  Todas
                </FilterLink>
              </div>
            }
          />
          {items.length === 0 ? (
            <Empty>
              {onlyHandoffs
                ? "Nadie está esperando. El asistente atiende todo."
                : "Todavía no hay conversaciones."}
            </Empty>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.conversationId} className="border-b border-border last:border-b-0">
                  <Link
                    href={`/inbox/${item.conversationId}`}
                    className="grid gap-1 px-5 py-3 hover:bg-muted"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{item.title}</span>
                      {item.handoff ? (
                        <Badge variant="warning">
                          {reasonLabel(item.handoff.reason, item.handoff.label)}
                        </Badge>
                      ) : null}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {item.last ? when(item.last.at, zone) : ""}
                      </span>
                    </span>
                    {item.handoff?.summary ? (
                      <span className="text-sm">{summaryText(item.handoff.summary)}</span>
                    ) : null}
                    {item.last ? (
                      <span className="truncate text-sm text-muted-foreground">
                        {item.last.direction === "outbound" ? "Usted: " : ""}
                        {item.last.preview}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Avisos"
            actions={
              notices.length > 0 ? (
                <form action={markAllReadAction}>
                  <Button size="sm" variant="ghost">
                    Marcar leídos
                  </Button>
                </form>
              ) : null
            }
          />
          {notices.length === 0 ? (
            <Empty>No hay avisos nuevos.</Empty>
          ) : (
            <ul>
              {notices.map((n) => (
                <li key={n.id} className="border-b border-border last:border-b-0">
                  <form action={openNotificationAction.bind(null, n.id, n.conversationId)}>
                    <button className="grid w-full gap-1 px-5 py-3 text-left text-sm hover:bg-muted">
                      <span>{n.text}</span>
                      <span className="text-xs text-muted-foreground">{when(n.at, zone)}</span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-1",
        active ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
