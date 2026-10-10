import { redirect } from "next/navigation";
import { logoutAction } from "./auth-actions.ts";
import { Button } from "../components/ui.tsx";
import { requireActor } from "../lib/session.ts";

/** Sends each role to its home: the owner to businesses, business users to the inbox. */
export default async function Home() {
  const actor = await requireActor();
  if (actor.business) redirect("/inbox");
  if (actor.isPlatformOwner) redirect("/businesses");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="mb-2 text-lg font-semibold">Su usuario no tiene un negocio asignado</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Pida acceso a quien administra la plataforma.
        </p>
        <form action={logoutAction}>
          <Button variant="outline">Salir</Button>
        </form>
      </div>
    </main>
  );
}
