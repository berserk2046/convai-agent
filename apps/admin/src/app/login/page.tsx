import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentActor } from "../../lib/session.ts";
import { LoginForm } from "./login-form.tsx";

export const metadata: Metadata = { title: "Ingresar" };

export default async function LoginPage() {
  if (await currentActor()) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">Ingresar</h1>
        <p className="mb-6 text-sm text-muted-foreground">Panel de su asistente de WhatsApp</p>
        <LoginForm />
      </div>
    </main>
  );
}
