import { isKnownModel } from "@platform/llm";
import {
  ConfigError,
  agentEnv,
  automationsEnv,
  baseEnv,
  databaseEnv,
  encryptionEnv,
  evalsEnv,
  inboundEnv,
  metaEnv,
  parseEnv,
  redisEnv,
} from "@platform/shared";

const workerEnv = baseEnv
  .extend(databaseEnv.shape)
  .extend(redisEnv.shape)
  .extend(metaEnv.pick({ META_GRAPH_VERSION: true, META_GRAPH_BASE_URL: true }).shape)
  .extend(encryptionEnv.shape)
  .extend(inboundEnv.shape)
  .extend(agentEnv.shape)
  .extend(automationsEnv.shape)
  .extend(evalsEnv.pick({ JUDGE_MODEL: true }).shape);

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env) {
  const config = parseEnv(workerEnv, env);
  const issues: string[] = [];
  if (config.INBOUND_HANDLER === "echo" && config.NODE_ENV === "production") {
    // The echo harness would answer real customers with their own words.
    issues.push("INBOUND_HANDLER: echo is a test harness and is refused in production");
  }
  if (config.INBOUND_HANDLER === "agent" && config.ANTHROPIC_API_KEY === undefined) {
    issues.push(
      "ANTHROPIC_API_KEY: is required when INBOUND_HANDLER=agent (use off or echo without a key)",
    );
  }
  if (!isKnownModel(config.JUDGE_MODEL)) {
    // Eval spend must be counted (principle 10), so the judge needs a price.
    issues.push(`JUDGE_MODEL: "${config.JUDGE_MODEL}" has no price in @platform/llm`);
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}
