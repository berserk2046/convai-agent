import { z } from "zod";

/**
 * Connection strings for the services in the root docker-compose.yml. Applied only when
 * NODE_ENV is not "production", so a fresh clone works without a .env file.
 */
export const DEV_DEFAULTS = {
  DATABASE_URL: "postgres://platform:platform@127.0.0.1:5432/platform",
  REDIS_URL: "redis://127.0.0.1:6379",
} as const;

export const baseEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export const databaseEnv = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export const redisEnv = z.object({
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

/** WhatsApp Cloud API (Meta). The Graph API version always comes from here (spec §0.4). */
export const metaEnv = z.object({
  META_APP_SECRET: z.string().min(16),
  META_VERIFY_TOKEN: z.string().min(16),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, 'must look like "v24.0"'),
  /** Overridden only by tests, which point it at a local fake Graph API. */
  META_GRAPH_BASE_URL: z.url({ protocol: /^https?$/ }).default("https://graph.facebook.com"),
});

/** Master key for secrets at rest: 32 random bytes, base64. */
export const encryptionEnv = z.object({
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
});

/** Inbound message pipeline (spec §3). */
export const inboundEnv = z.object({
  /** Messages from one contact within this window are answered together. */
  INBOUND_DEBOUNCE_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
  /** "agent" answers with the AI agent; "echo" is the M2 test harness; "off" only stores. */
  INBOUND_HANDLER: z.enum(["agent", "echo", "off"]).default("agent"),
});

/**
 * The agent's key and spend (spec §14, principle 10). The key is only needed by the agent.
 * The model comes from the template (`agent.model`, required) or the business override.
 */
export const agentEnv = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Monthly LLM cap for businesses without their own `limits.llm_usd_month`. */
  LLM_BUDGET_USD_MONTH: z.coerce.number().positive().default(15),
});

/** Automatic messages (spec §9, principle 10). */
export const automationsEnv = z.object({
  /**
   * "on" creates and edits message templates at Meta. Off until the platform owner
   * approves submitting templates (spec §15 M4); status sync and webhooks work either way.
   */
  META_TEMPLATE_SUBMISSION: z.enum(["off", "on"]).default("off"),
  /** Monthly marketing-message cap for businesses without their own `limits.marketing_msgs_month`. */
  MARKETING_MSGS_MONTH: z.coerce.number().int().min(0).default(500),
});

export const apiEnv = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
});

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Validates environment variables against a schema. Empty values count as unset, which
 * matches how `KEY=` lines in .env files are meant. Error messages name the variable and
 * the problem but never echo the value, since values may be secrets.
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(withDevDefaults(withoutEmptyValues(env)));
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}

function withoutEmptyValues(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") clean[key] = value;
  }
  return clean;
}

function withDevDefaults(env: Record<string, string>): Record<string, string> {
  if (env.NODE_ENV === "production") return env;
  return { ...DEV_DEFAULTS, ...env };
}
