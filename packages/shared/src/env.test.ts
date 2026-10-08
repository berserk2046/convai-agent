import { describe, expect, it } from "vitest";
import { ConfigError, DEV_DEFAULTS, baseEnv, databaseEnv, parseEnv, redisEnv } from "./env.ts";

const appEnv = baseEnv.extend(databaseEnv.shape).extend(redisEnv.shape);

describe("parseEnv", () => {
  it("falls back to the compose services outside production", () => {
    const config = parseEnv(appEnv, {});
    expect(config).toEqual({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      DATABASE_URL: DEV_DEFAULTS.DATABASE_URL,
      REDIS_URL: DEV_DEFAULTS.REDIS_URL,
    });
  });

  it("prefers explicit values over dev defaults", () => {
    const url = "postgres://u:p@db.internal:6543/app";
    expect(parseEnv(databaseEnv, { DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it("requires connection strings in production", () => {
    expect(() => parseEnv(appEnv, { NODE_ENV: "production" })).toThrow(ConfigError);
    try {
      parseEnv(appEnv, { NODE_ENV: "production" });
    } catch (error) {
      expect((error as ConfigError).issues.map((i) => i.split(":")[0])).toEqual([
        "DATABASE_URL",
        "REDIS_URL",
      ]);
    }
  });

  it("treats empty values as unset", () => {
    const config = parseEnv(appEnv, { LOG_LEVEL: "", DATABASE_URL: "" });
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.DATABASE_URL).toBe(DEV_DEFAULTS.DATABASE_URL);
  });

  it("rejects a connection string with the wrong protocol", () => {
    expect(() => parseEnv(databaseEnv, { DATABASE_URL: "mysql://u:p@h/db" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("never echoes the rejected value, which may be a secret", () => {
    const secret = "s3cr3t-password-value";
    let message = "";
    try {
      parseEnv(databaseEnv, { DATABASE_URL: `not a url ${secret}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(secret);
  });
});
