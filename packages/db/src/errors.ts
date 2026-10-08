import type { Issue } from "@platform/templates";

/** The uploaded template failed validation; `issues` has path, message and line. */
export class TemplateInvalidError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    const errors = issues.filter((i) => i.severity === "error").length;
    super(`template is invalid (${errors} error(s))`);
    this.name = "TemplateInvalidError";
    this.issues = issues;
  }
}

/** Published and deprecated versions are immutable. */
export class TemplateVersionLockedError extends Error {
  constructor(slug: string, version: string, status: string) {
    super(`${slug}@${version} is ${status}; upload a new version instead`);
    this.name = "TemplateVersionLockedError";
  }
}

export class TemplateNotPublishedError extends Error {
  constructor(slug: string, version: string) {
    super(`${slug}@${version} is not a published template`);
    this.name = "TemplateNotPublishedError";
  }
}

export class BusinessNotFoundError extends Error {
  constructor() {
    super("business not found");
    this.name = "BusinessNotFoundError";
  }
}

export interface FieldIssue {
  /** Dotted path into the submitted data, e.g. "services[0].price_cop". */
  path: string;
  message: string;
}

/** Input rejected before reaching the database; the admin shows `issues` next to fields. */
export class InvalidInputError extends Error {
  readonly issues: readonly FieldIssue[];

  constructor(what: string, issues: readonly FieldIssue[]) {
    super(
      `${what} is invalid: ${issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; ")}`,
    );
    this.name = "InvalidInputError";
    this.issues = issues;
  }
}

/** The slot was taken between checking availability and booking (exclusion constraint). */
export class SlotTakenError extends Error {
  constructor() {
    super("that slot was just taken");
    this.name = "SlotTakenError";
  }
}

/** SQLSTATE of a Postgres error, also when Drizzle wraps it in `cause`. */
export function pgErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string") return code;
    current = cause;
  }
  return null;
}
