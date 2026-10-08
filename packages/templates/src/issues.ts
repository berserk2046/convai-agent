/** A path into the template document, e.g. ["automations", 0, "trigger", "offset"]. */
export type DocPath = readonly (string | number)[];

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  /** Dotted path, e.g. "automations[0].trigger.offset". Empty for document-level issues. */
  path: string;
  message: string;
  /** 1-based line in the YAML source, when known. */
  line?: number;
}

/** ["automations", 0, "trigger"] → "automations[0].trigger" */
export function formatPath(path: DocPath): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? part : `.${part}`;
  }
  return out;
}

/** Collects issues for one validation run. Paths stay structured until reported. */
export class IssueList {
  readonly entries: { severity: Severity; path: DocPath; message: string }[] = [];

  error(path: DocPath, message: string): void {
    this.entries.push({ severity: "error", path, message });
  }

  warning(path: DocPath, message: string): void {
    this.entries.push({ severity: "warning", path, message });
  }

  get hasErrors(): boolean {
    return this.entries.some((e) => e.severity === "error");
  }

  /** Number of errors so far; lets a check tell whether it added any. */
  get errorCount(): number {
    return this.entries.filter((e) => e.severity === "error").length;
  }
}
