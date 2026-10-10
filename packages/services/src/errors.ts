/**
 * Errors the admin turns into responses. Anything from another tenant is NotFound, never
 * Forbidden: the admin must not reveal that it exists (principle 6).
 */

export class NotAuthenticatedError extends Error {
  constructor() {
    super("not logged in");
    this.name = "NotAuthenticatedError";
  }
}

export class ForbiddenError extends Error {
  constructor(what = "this") {
    super(`not allowed to use ${what}`);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** A rule of the business stops the action, with a message for the person (Spanish). */
export class ActionRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionRefusedError";
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids arrive from URLs and form fields (a bound action argument can be edited in the
 * browser): a malformed one is simply not found, rather than a database error.
 */
export function requireIds(what: string, ...ids: (string | null | undefined)[]): void {
  for (const id of ids) {
    if (id !== null && id !== undefined && !UUID.test(id)) throw new NotFoundError(what);
  }
}
