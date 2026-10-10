import Link from "next/link";
import type { ReactNode } from "react";
import { logoutAction } from "../app/auth-actions.ts";
import { NavLink } from "./nav-link.tsx";
import { Button } from "./ui.tsx";

/** Page frame: brand, navigation, who's logged in, and a slot above the content (banners). */
export function Shell({
  brand,
  nav,
  user,
  logoutLabel,
  banner,
  children,
}: {
  brand: ReactNode;
  nav: { href: string; label: ReactNode }[];
  user: ReactNode;
  logoutLabel: string;
  banner?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      {banner}
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="font-semibold">
            {brand}
          </Link>
          <nav className="flex flex-1 flex-wrap gap-1">
            {nav.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            {user}
            <form action={logoutAction}>
              <Button variant="ghost" size="sm">
                {logoutLabel}
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
