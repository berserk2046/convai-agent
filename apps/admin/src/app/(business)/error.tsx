"use client";

import { Button } from "../../components/ui.tsx";

/** Unexpected failures on business screens; the details stay in the server log (digest). */
export default function BusinessError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="mx-auto grid max-w-md gap-3 py-16 text-center">
      <h1 className="text-lg font-semibold">Algo salió mal</h1>
      <p className="text-sm text-muted-foreground">
        No se pudo completar la acción. Intente de nuevo; si sigue pasando, avísele a quien
        administra la plataforma
        {error.digest ? ` (código ${error.digest})` : ""}.
      </p>
      <div>
        <Button variant="outline" onClick={() => retry()}>
          Intentar de nuevo
        </Button>
      </div>
    </div>
  );
}
