import { createLogger, type Logger } from "@platform/shared";
import type { LogEntry } from "./report.ts";

/**
 * A logger whose lines stay with the sandbox run instead of the process log: a sandbox's
 * "emergency" or "price guard" alert is a test result, not something an operator should
 * be paged for. Info and above are kept, without fields (no message text).
 */
export function captureLogs(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = createLogger(
    { level: "info", name: "sandbox" },
    { write: (line: string) => entries.push(logEntry(line)) },
  );
  return { logger, entries };
}

const LEVELS: Record<number, LogEntry["level"]> = {
  30: "info",
  40: "warn",
  50: "error",
  60: "error",
};

function logEntry(line: string): LogEntry {
  const parsed = JSON.parse(line) as { level: number; msg: string; alert?: string };
  return {
    level: LEVELS[parsed.level] ?? "info",
    msg: parsed.msg,
    ...(parsed.alert ? { alert: parsed.alert } : {}),
  };
}
