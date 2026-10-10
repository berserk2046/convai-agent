# 0013 — Instant inbox updates

Status: accepted (M5). Replaces ADR 0011 point 12, where the inbox polled every 15 seconds.

## Sources

- **PostgreSQL 16 `NOTIFY` / `LISTEN`**:
  - inside a transaction, a notification is delivered only if and when the transaction
    commits;
  - identical notifications (same channel and payload) from one transaction are delivered
    once;
  - a session receives only the notifications for channels it LISTENs on.

  `changes.test.ts` checks the first two against the real server.

- **Next.js 16.3.8** (bundled docs, `route.md`):
  - a route handler can return a streaming `Response`;
  - `GET` handlers are not cached since v15.

  Next's bundled `compression` skips responses with `Cache-Control: no-transform` (checked
  in `next/dist/compiled/compression`).

- **HTML Living Standard, server-sent events**:
  - `EventSource` reconnects by itself after a dropped stream, waiting the `retry:` delay;
  - it gives up (`readyState` CLOSED) when a response isn't a 200 event stream.

## Decision

1. **Database triggers signal changes** (migration 0013).
   - Six tables carry a row trigger that fires after every insert, update and delete:
     `messages`, `conversations`, `contacts`, `handoffs`, `staff_notifications` and
     `bookings`.
   - The trigger sends a notification on the `inbox_changed` channel, with the row's
     business id as the payload.
   - Triggers catch every writer (the webhook API, the worker, the admin, anything added
     later) with no publish call to forget in each code path.
   - Because notifications are sent at commit, a tab never re-renders before the change is
     visible.
2. **The payload is the business id only.** No message text or names go through Postgres
   notifications (principle 9), and the 8,000-byte payload limit never matters.
3. **One listening connection per admin process.** `createChangeFeed` (`@platform/db`) holds
   one dedicated connection, because a pooled connection can't LISTEN. It hands each
   notification to the subscribers of that business.
   - If the connection drops, it reconnects with backoff (up to 30 seconds), then tells
     every subscriber to re-render, in case a change was missed.
4. **`GET /inbox/events` streams server-sent events.**
   - The session is checked when the stream opens. It is checked again on every 25-second
     heartbeat, which also keeps proxies from closing an idle stream.
   - With no session or business, the request gets a 401. After a logout or a switch of
     business, the stream ends.
   - Events say only "changed". The tab then calls `router.refresh()`, and the page re-reads
     its data with the usual session and tenant checks. So the stream never carries tenant
     data, and the security boundary stays in the pages (ADR 0011).
5. **The browser side** is `LiveRefresh`, on `/inbox` and `/inbox/[id]`.
   - It keeps an `EventSource` open while the tab is visible and closes it when the tab is
     hidden.
   - It re-renders once after reconnecting, or when the tab is shown again.
   - Changes within 150 ms become one re-render (a reply followed by its delivery
     statuses).
   - Form inputs keep what staff are typing.
6. **Rejected alternatives:**
   - Redis pub/sub would need a publish call in every write path.
   - WebSockets are two-way, which the inbox doesn't need, and need more setup than SSE,
     which is plain HTTP and reconnects by itself.

## Consequences

- Each admin process uses one extra Postgres connection. Each open inbox tab holds one HTTP
  connection while visible.
  - Over HTTP/1.1 (local dev), browsers allow about six connections per host. Hidden tabs
    disconnect, so this only matters with many visible inbox tabs at once.
  - Production is HTTP/2 behind Caddy (M7).
- Every write to those six tables runs a small trigger. A bulk update (such as the
  message-retention purge) sends one notification per business per transaction.
- Delivery and read statuses update open conversations live, because they are updates to
  `messages`.
- If the browser leaves a page while it is re-rendering (for example, staff click a link
  just after an event), Next logs `Error: The destination stream closed early.` That line
  is React noticing the abandoned render. It is harmless, and it happens more often now
  that tabs re-render on events.
- **M7:** check that Caddy passes the stream through unbuffered and uncompressed. A deploy
  restart drops the streams; the browsers reconnect and re-render.
- Other screens (`/bookings`, the unread badge outside the inbox) still update on
  navigation. The same feed can serve them later.
- `pnpm test:e2e` checks the live path: the inbox has no polling, so the emergency appears
  only through an event. With events disabled, the test fails at that step.
