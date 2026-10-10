import type { DiffLine } from "@platform/services";
import { Badge, cn } from "./ui.tsx";

export function StatusBadge({ status }: { status: string }) {
  const variant = status === "published" ? "success" : status === "draft" ? "warning" : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

/** Changed template sections, as a unified diff of their YAML. */
export function DiffView({ sections }: { sections: { section: string; lines: DiffLine[] }[] }) {
  if (sections.length === 0) {
    return <p className="text-sm text-muted-foreground">No differences.</p>;
  }
  return (
    <div className="grid gap-4">
      {sections.map(({ section, lines }) => (
        <section key={section} className="overflow-hidden rounded-md border border-border">
          <h3 className="border-b border-border bg-muted px-3 py-1.5 font-mono text-xs font-medium">
            {section}
          </h3>
          <pre className="overflow-x-auto text-xs leading-5">
            {lines.map((line, i) =>
              line.kind === "skip" ? (
                <div key={i} className="bg-muted/50 px-3 text-muted-foreground">
                  ⋯ {line.count} unchanged lines
                </div>
              ) : (
                <div
                  key={i}
                  className={cn(
                    "px-3 whitespace-pre",
                    line.kind === "added" && "bg-success/10",
                    line.kind === "removed" && "bg-destructive/10",
                  )}
                >
                  {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                  {line.text}
                </div>
              ),
            )}
          </pre>
        </section>
      ))}
    </div>
  );
}
