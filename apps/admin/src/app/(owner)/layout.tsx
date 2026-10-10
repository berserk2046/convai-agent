import type { ReactNode } from "react";
import { Shell } from "../../components/shell.tsx";
import { requireOwnerPage } from "../../lib/session.ts";

/** Platform-owner screens (English, spec §12). Each page checks the role again. */
export default async function OwnerLayout({ children }: { children: ReactNode }) {
  const actor = await requireOwnerPage();
  return (
    <Shell
      brand="Platform"
      nav={[
        { href: "/businesses", label: "Businesses" },
        { href: "/templates", label: "Templates" },
        { href: "/usage", label: "Usage" },
      ]}
      user={<span>{actor.email}</span>}
      logoutLabel="Log out"
    >
      {children}
    </Shell>
  );
}
