import { pino, type DestinationStream, type LevelWithSilent, type Logger } from "pino";

/**
 * Fields that never reach the logs in clear: credentials, and message content (which is
 * personal data under Ley 1581). Paths use pino's redact syntax: `*.x` matches one level
 * deep only, so never log raw provider payloads; pick the fields you need instead.
 */
export const REDACTED_PATHS = [
  "authorization",
  "*.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "access_token",
  "*.access_token",
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "secret",
  "*.secret",
  "password",
  "*.password",
  "body",
  "*.body",
] as const;

export interface LoggerOptions {
  level: LevelWithSilent;
  name?: string;
}

export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const config = {
    level: options.level,
    ...(options.name === undefined ? {} : { name: options.name }),
    redact: { paths: [...REDACTED_PATHS], censor: "[redacted]" },
  };
  return destination === undefined ? pino(config) : pino(config, destination);
}

/**
 * Logs something an operator must act on (failed send, rejected template, unknown phone
 * number…). Error level plus an `alert` code; Sentry picks these up once wired (M7).
 */
export function alert(
  logger: Logger,
  code: string,
  details: Record<string, unknown>,
  message: string,
): void {
  logger.error({ ...details, alert: code }, message);
}

export type { Logger };
