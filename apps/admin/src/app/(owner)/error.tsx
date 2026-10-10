"use client";

import { Button } from "../../components/ui.tsx";

/** Unexpected failures on owner screens; match the digest with the server log. */
export default function OwnerError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="mx-auto grid max-w-md gap-3 py-16 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        The server logged the error{error.digest ? ` with digest ${error.digest}` : ""}.
      </p>
      <div>
        <Button variant="outline" onClick={() => retry()}>
          Try again
        </Button>
      </div>
    </div>
  );
}
