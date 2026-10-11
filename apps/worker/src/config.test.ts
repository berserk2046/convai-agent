import { randomBytes } from "node:crypto";
import { ConfigError } from "@platform/shared";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.ts";

const env = {
  META_GRAPH_VERSION: "v24.0",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ANTHROPIC_API_KEY: "sk-ant-test",
};

describe("loadWorkerConfig", () => {
  it("defaults to the agent, a 3-second debounce and Meta's Graph host", () => {
    expect(loadWorkerConfig(env)).toMatchObject({
      INBOUND_HANDLER: "agent",
      LLM_BUDGET_USD_MONTH: 15,
      INBOUND_DEBOUNCE_MS: 3000,
      META_GRAPH_BASE_URL: "https://graph.facebook.com",
    });
  });

  it("keeps template submission to Meta off unless turned on", () => {
    expect(loadWorkerConfig(env)).toMatchObject({
      META_TEMPLATE_SUBMISSION: "off",
      MARKETING_MSGS_MONTH: 500,
    });
    expect(
      loadWorkerConfig({ ...env, META_TEMPLATE_SUBMISSION: "on" }).META_TEMPLATE_SUBMISSION,
    ).toBe("on");
    expect(() => loadWorkerConfig({ ...env, META_TEMPLATE_SUBMISSION: "yes" })).toThrow(
      /META_TEMPLATE_SUBMISSION/,
    );
  });

  it("requires the Graph version and a 32-byte key", () => {
    expect(() => loadWorkerConfig({})).toThrow(/META_GRAPH_VERSION[\s\S]*ENCRYPTION_KEY/);
    expect(() => loadWorkerConfig({ ...env, META_GRAPH_VERSION: "24" })).toThrow(/v24\.0/);
    expect(() =>
      loadWorkerConfig({ ...env, ENCRYPTION_KEY: randomBytes(16).toString("base64") }),
    ).toThrow(/32 bytes/);
  });

  it("needs an Anthropic key only for the agent", () => {
    const { ANTHROPIC_API_KEY: _key, ...noKey } = env;
    expect(() => loadWorkerConfig(noKey)).toThrow(/ANTHROPIC_API_KEY/);
    expect(loadWorkerConfig({ ...noKey, INBOUND_HANDLER: "off" }).INBOUND_HANDLER).toBe("off");
  });

  it("refuses the echo harness in production", () => {
    const production = {
      ...env,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@db/x",
      REDIS_URL: "redis://r:6379",
    };
    expect(() => loadWorkerConfig({ ...production, INBOUND_HANDLER: "echo" })).toThrow(ConfigError);
    expect(loadWorkerConfig({ ...env, INBOUND_HANDLER: "echo" }).INBOUND_HANDLER).toBe("echo");
  });

  it("grades evals with a priced judge model", () => {
    expect(loadWorkerConfig(env).JUDGE_MODEL).toBe("claude-sonnet-5-5");
    expect(() => loadWorkerConfig({ ...env, JUDGE_MODEL: "gpt-x" })).toThrow(/JUDGE_MODEL/);
  });
});
