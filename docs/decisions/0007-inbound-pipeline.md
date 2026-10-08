# 0007 — Inbound pipeline: dedupe, debounce, exactly-once replies

Status: accepted (M2)

## Sources

Payload shapes, the signature scheme, error codes and limits were checked against Meta's
WhatsApp Cloud API docs on 2026-10-04:

- messages webhook reference (text, button, interactive, reaction, image, unsupported,
  status);
- the Create a webhook endpoint page;
- the Message API and interactive-template examples;
- the error codes page;
- the webhooks overview (3 MB payloads, up to 7 days of retries on non-200).

The recorded payloads are in `packages/channels/fixtures/`. The template **body** component
shape follows the classic `components` format, while the quick-reply **button** shape was
verified verbatim. Template sends get their first live check in M4.

## Decision

1. **API** (`POST /webhooks/whatsapp`):
   - Verify `X-Hub-Signature-256` over the raw bytes; reject with 401 otherwise.
   - Resolve the business from `phone_number_id`: a platform-level lookup, cached for 60 s.
   - Store each message with a unique `wa_message_id`, so a conflict is a duplicate and is
     skipped.
   - Enqueue, and return 200.
   - Unknown numbers, signed-but-unreadable bodies and other fields also get 200 plus a log
     or alert, because retries can't fix them (decision A4). Storage errors return 500, so
     Meta re-delivers; storage is idempotent.
2. **Reactions, edits, system and unsupported messages** are stored as already handled and
   never wake the worker (B16). Only actionable messages move the 24-hour window.
3. **Debounce.** One BullMQ job per `business:contact` uses deduplication `replace` with a
   delay (a trailing debounce) plus `keepLastIfActive`, so there's never a parallel batch for
   one contact and a message that arrives mid-run gets exactly one follow-up. This replaces
   the advisory lock planned in spec review B14. `queue.test.ts` proves the behavior on
   real Redis.
4. **Batch processing.**
   - Read the unprocessed messages.
   - Compute the replies (the responder, later the agent). This runs before any commit, so
     it's safe to retry.
   - In one transaction, claim the messages and insert the replies as pending rows with
     idempotency keys. A partial claim means another run won; that run rolls back and stays
     silent.
   - Send the pending rows.
5. **Sending** (`deliverPending`):
   - Mark `send_attempted_at`, then call Meta.
   - _transient_ errors (rate limit, 5xx, refused connection): release the mark and retry
     the job.
   - _permanent_ and _config_ errors: mark the message failed and raise an alert.
   - _unknown_ outcomes (timeout, 2xx without an id, crash after the mark): mark failed and
     alert, never resend. **Exactly once when Meta tells us; at most once otherwise.**
6. **Statuses** only move forward (pending < sent < delivered < read < played < failed),
   because webhooks arrive out of order. `pricing` is stored for cost accounting (M3/M4).
7. **The WhatsApp profile name is not stored** before consent (A10, M3).
8. **The echo responder** (`INBOUND_HANDLER=echo`) exists only to test M2. The worker
   refuses to start with it in production.
