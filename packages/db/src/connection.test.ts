import { describe, expect, it } from "vitest";
import { connectionError, isTransientConnectionError, waitForPostgres } from "./connection.ts";

describe("connectionError", () => {
  const url = "postgres://admin:hunter2@127.0.0.1:5432/platform";

  it("hints at docker compose when the server is unreachable", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const error = connectionError(url, cause);
    expect(error.message).toBe(
      "Postgres is not reachable at 127.0.0.1:5432/platform. Is it running? (docker compose up -d)",
    );
    expect(error.cause).toBe(cause);
  });

  it("passes other failures through without credentials", () => {
    const cause = Object.assign(new Error('password authentication failed for user "admin"'), {
      code: "28P01",
    });
    const error = connectionError(url, cause);
    expect(error.message).toContain('password authentication failed for user "admin"');
    expect(error.message).not.toContain("hunter2");
  });
});

describe("isTransientConnectionError", () => {
  it("retries only boot-time failures", () => {
    expect(isTransientConnectionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransientConnectionError({ code: "57P03" })).toBe(true);
    expect(isTransientConnectionError({ code: "28P01" })).toBe(false);
    expect(isTransientConnectionError(new Error("boom"))).toBe(false);
    expect(isTransientConnectionError(null)).toBe(false);
  });
});

describe("waitForPostgres", () => {
  it("gives up after the timeout when nothing listens", async () => {
    // Port 1 is privileged and never runs Postgres, so connect is refused immediately.
    await expect(waitForPostgres("postgres://u:p@127.0.0.1:1/x", 600)).rejects.toThrow(
      /not reachable at 127\.0\.0\.1:1\/x/,
    );
  });
});
