import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "../../components/ui.tsx";
import { requireActor } from "../../lib/session.ts";
import { PasswordForm } from "./password-form.tsx";

export const metadata: Metadata = { title: "Cuenta" };

/** Every user's own account: change the password (the platform owner resets others'). */
export default async function AccountPage() {
  const actor = await requireActor();
  return (
    <main className="mx-auto grid max-w-md gap-4 px-4 py-12">
      <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Volver
      </Link>
      <Card>
        <CardHeader title={actor.name} description={actor.email} />
        <CardContent>
          <PasswordForm />
        </CardContent>
      </Card>
    </main>
  );
}
