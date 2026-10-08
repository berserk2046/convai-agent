import { describe, expect, it } from "vitest";
import { describeDatabaseUrl, withDatabaseName } from "./url.ts";

describe("describeDatabaseUrl", () => {
  it("keeps host, port and database but drops credentials", () => {
    const described = describeDatabaseUrl("postgres://admin:hunter2@db.internal:6543/platform");
    expect(described).toBe("db.internal:6543/platform");
  });

  it("shows the default port when the URL omits it", () => {
    expect(describeDatabaseUrl("postgres://u:p@localhost/platform")).toBe(
      "localhost:5432/platform",
    );
  });
});

describe("withDatabaseName", () => {
  it("swaps only the database name", () => {
    const url = withDatabaseName(
      "postgres://u:p@localhost:5432/platform?sslmode=disable",
      "test_1",
    );
    expect(url).toBe("postgres://u:p@localhost:5432/test_1?sslmode=disable");
  });
});
