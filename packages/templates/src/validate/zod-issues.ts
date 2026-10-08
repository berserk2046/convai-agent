import type { z } from "zod";
import type { DocPath, IssueList } from "../issues.ts";

/** Adds Zod issues to the list with readable messages, under `base`. */
export function addZodIssues(issues: IssueList, error: z.ZodError, base: DocPath = []): void {
  for (const issue of error.issues) {
    const path = [...base, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))];
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) issues.error([...path, key], "is not a known field");
    } else if (issue.code === "invalid_type" && issue.message.endsWith("received undefined")) {
      issues.error(path, "is required");
    } else if (issue.code === "invalid_union") {
      issues.error(path, "doesn't match any of the allowed forms");
    } else {
      issues.error(path, issue.message);
    }
  }
}
