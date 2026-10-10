import Link from "next/link";

/** Unknown pages, other tenants' ids and screens the role can't use all look the same. */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="grid max-w-sm gap-3 text-center">
        <h1 className="text-lg font-semibold">No se encontró la página</h1>
        <p className="text-sm text-muted-foreground">
          Puede que no exista o que su usuario no tenga acceso.
        </p>
        <Link href="/" className="text-sm underline">
          Ir al inicio
        </Link>
      </div>
    </main>
  );
}
