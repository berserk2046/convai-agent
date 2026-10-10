import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

/** Migration 0013's triggers notify this channel, with the business id as the payload. */
export const INBOX_CHANNEL = "inbox_changed";

export interface ChangeFeed {
  /**
   * Calls `onChange` after each committed change for `key` (a business id), and after a
   * reconnect, when changes may have been missed. Returns the unsubscribe function.
   */
  subscribe(key: string, onChange: () => void): () => void;
  /** Resolves once the feed is listening. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Fans Postgres notifications on one channel out to subscribers, by payload (ADR 0013).
 * It holds one dedicated connection, because a pooled one can't LISTEN: notifications go
 * to the session that ran LISTEN. The connection opens with the first subscriber and is
 * reopened, with backoff, whenever it drops.
 */
export function createChangeFeed(
  url: string,
  options: { channel: string; onError?: (error: unknown) => void; maxRetryMs?: number },
): ChangeFeed {
  const subscribers = new Map<string, Set<() => void>>();
  const maxRetryMs = options.maxRetryMs ?? 30_000;
  let client: pg.Client | null = null;
  let connecting: Promise<void> | null = null;
  let listenedBefore = false;
  let closed = false;
  // A function, so the loop sees close() calls made while it awaited.
  const isClosed = () => closed;

  function emit(key: string): void {
    for (const onChange of subscribers.get(key) ?? []) onChange();
  }

  function emitAll(): void {
    for (const key of subscribers.keys()) emit(key);
  }

  function start(): Promise<void> {
    connecting ??= connect().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function connect(): Promise<void> {
    for (let attempt = 0; !isClosed(); attempt += 1) {
      if (attempt > 0) await sleep(Math.min(maxRetryMs, 250 * 2 ** attempt));
      const next = new pg.Client({ connectionString: url, keepAlive: true });
      next.on("notification", (message) => {
        if (message.channel === options.channel && message.payload) emit(message.payload);
      });
      // An error on an idle connection is followed by "end"; unhandled, it would crash.
      next.on("error", (error) => options.onError?.(error));
      next.on("end", () => {
        if (client !== next) return;
        client = null;
        if (!closed) void start();
      });
      try {
        await next.connect();
        await next.query(`LISTEN ${next.escapeIdentifier(options.channel)}`);
      } catch (error) {
        options.onError?.(error);
        await next.end().catch(() => undefined);
        continue;
      }
      if (isClosed()) {
        await next.end();
        return;
      }
      client = next;
      if (listenedBefore) emitAll();
      listenedBefore = true;
      return;
    }
  }

  return {
    subscribe(key, onChange) {
      let set = subscribers.get(key);
      if (!set) subscribers.set(key, (set = new Set()));
      set.add(onChange);
      if (!client) void start();
      return () => {
        set.delete(onChange);
        if (set.size === 0 && subscribers.get(key) === set) subscribers.delete(key);
      };
    },
    async ready() {
      if (!client) await start();
    },
    async close() {
      closed = true;
      subscribers.clear();
      await connecting;
      await client?.end();
      client = null;
    },
  };
}
