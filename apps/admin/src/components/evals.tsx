import { Badge } from "./ui.tsx";

/** Eval run pieces shared by the template version page and the run report. */

export function EvalRunBadge({
  status,
  gatePassed,
}: {
  status: string;
  gatePassed: boolean | null;
}) {
  if (status === "queued") return <Badge variant="outline">queued</Badge>;
  if (status === "running") return <Badge variant="warning">running</Badge>;
  if (status === "error") return <Badge variant="destructive">error</Badge>;
  return gatePassed ? (
    <Badge variant="success">gate passed</Badge>
  ) : (
    <Badge variant="destructive">gate failed</Badge>
  );
}

/** A scenario run: passed, failed (the agent's behavior) or error (API, recordings). */
export function RunStatusBadge({ status }: { status: string }) {
  const variant = status === "passed" ? "success" : status === "failed" ? "destructive" : "warning";
  return <Badge variant={variant}>{status}</Badge>;
}

export function percent(rate: number | null): string {
  return rate === null ? "—" : `${(rate * 100).toFixed(0)}%`;
}

export function dollars(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}
