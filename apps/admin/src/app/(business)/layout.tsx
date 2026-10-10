import Link from "next/link";
import type { ReactNode } from "react";
import { unreadNotificationCount } from "@platform/services";
import { stopImpersonatingAction, switchBusinessAction } from "../auth-actions.ts";
import { Shell } from "../../components/shell.tsx";
import { Badge, Button, Select } from "../../components/ui.tsx";
import { services } from "../../lib/server.ts";
import { requireBusinessPage } from "../../lib/session.ts";

/** Business screens (Spanish, spec §12): staff see the inbox and bookings; admins all. */
export default async function BusinessLayout({ children }: { children: ReactNode }) {
  const actor = await requireBusinessPage();
  const business = actor.business;
  if (!business) return null;
  const unread = await unreadNotificationCount(services(), actor);
  const admin = business.role === "business_admin";
  return (
    <Shell
      brand={business.name}
      nav={[
        {
          href: "/inbox",
          label: (
            <>
              Bandeja
              {unread > 0 ? (
                <Badge variant="primary" aria-label={`${String(unread)} avisos sin leer`}>
                  {unread}
                </Badge>
              ) : null}
            </>
          ),
        },
        { href: "/bookings", label: "Citas" },
        ...(admin
          ? [
              { href: "/setup", label: "Configuración" },
              { href: "/automations", label: "Mensajes automáticos" },
              { href: "/reports", label: "Informes" },
            ]
          : []),
      ]}
      user={
        <>
          {actor.memberships.length > 1 && !business.impersonating ? (
            <form action={switchBusinessAction} className="flex items-center gap-2">
              <Select name="businessId" defaultValue={business.id} className="h-8 w-44 text-xs">
                {actor.memberships.map((m) => (
                  <option key={m.businessId} value={m.businessId}>
                    {m.businessName}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="outline">
                Cambiar
              </Button>
            </form>
          ) : null}
          <Link href="/account" className="hover:text-foreground">
            {actor.name}
          </Link>
        </>
      }
      logoutLabel="Salir"
      banner={
        business.impersonating ? (
          <div className="bg-warning/25 px-4 py-2 text-center text-sm">
            Viewing {business.name} as its admin (impersonation, audited).{" "}
            <form action={stopImpersonatingAction} className="inline">
              <button className="font-medium underline">Stop impersonating</button>
            </form>
          </div>
        ) : null
      }
    >
      {children}
    </Shell>
  );
}
