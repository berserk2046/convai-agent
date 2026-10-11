import type { ReactNode } from "react";
import { Badge, cn } from "./ui.tsx";

/**
 * A conversation's pieces, shared by the inbox, the eval reports and the playground. The
 * bubble colors are the `--color-message-*` tokens in globals.css.
 */

/** One message: from the customer ("in", left) or from the business ("out", right). */
export function ChatBubble({
  side,
  meta,
  failed,
  children,
}: {
  side: "in" | "out";
  meta: ReactNode;
  failed?: boolean;
  children: ReactNode;
}) {
  const inbound = side === "in";
  return (
    <li
      className={cn("grid max-w-[80%] gap-1", inbound ? "justify-self-start" : "justify-self-end")}
    >
      <span className={cn("text-xs text-muted-foreground", inbound ? "" : "text-right")}>
        {meta}
      </span>
      <p
        className={cn(
          "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
          inbound ? "rounded-tl-none bg-message-in" : "rounded-tr-none bg-message-out",
          failed ? "ring-1 ring-destructive" : "",
        )}
      >
        {children}
      </p>
    </li>
  );
}

export interface ToolCallView {
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
}

/** The agent's tool calls of one turn, each expandable to its input and result. */
export function ToolCalls({ calls }: { calls: readonly ToolCallView[] }) {
  if (calls.length === 0) return null;
  return (
    <li className="grid gap-1 justify-self-end">
      {calls.map((call, i) => (
        <details key={i} className="rounded-md border border-border bg-card text-xs">
          <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 font-mono">
            {call.name}
            {call.isError ? <Badge variant="destructive">error</Badge> : null}
          </summary>
          <div className="grid gap-2 border-t border-border px-2 py-2">
            <Json label="Input" value={call.input} />
            <Json label="Result" value={call.result} />
          </div>
        </details>
      ))}
    </li>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="grid gap-1">
      <span className="text-muted-foreground">{label}</span>
      <pre className="max-h-64 overflow-auto rounded bg-muted px-2 py-1 leading-5">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
