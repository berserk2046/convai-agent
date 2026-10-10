# 0012 — Recording WhatsApp cost per message (spec-review B23)

Status: accepted (M5)

## Sources

Meta's WhatsApp Business Platform docs, fetched 2026-10-09:

- **Pricing**:
  - Meta charges per delivered message, by category (marketing, utility, authentication,
    service) and by the recipient's market.
  - Service messages are billable past the 1,000 free per business phone number each month.
- **Rate card**: "Cost per message in USD", effective 2026-10-01 (the xlsx, read with a
  stdlib script). Colombia: marketing 0.0125, utility 0.0008, authentication 0.0008,
  service 0.0008. Volume tiers start past 100,000 utility messages a month.
- **Status webhook reference**: the `pricing` object on `sent`, `delivered` and `read`
  statuses has `billable` (being retired), `pricing_model`, `type` (`regular`,
  `free_customer_service`, `free_entry_point`) and `category`, which includes group and
  international variants.

## Decision

1. **Record a charge when a message is delivered.** The charge is written when a status
   webhook says `delivered`, `read` or `played` and carries a `pricing` block. It is recorded
   in the same tenant transaction as the status update.
2. **What counts as billable.** If the webhook has `pricing.type`, the message is billable
   when `type === "regular"`; otherwise when `billable === true`. This counts service
   messages past the free 1,000 as Meta does, without counting messages ourselves.
3. **Price.** The category from the webhook is mapped to a usage kind (`wa_marketing`,
   `wa_utility`, `wa_auth`, `wa_service`). The amount is the list rate for the recipient's
   market. Rates live in `packages/shared/src/wa-rates.ts`, with the date they took effect.
4. **Only Colombia is priced.** Any other market is priced at Colombian rates and marked
   `estimated: true` in the event's details.
5. **At most one charge per message.** `usage_events.message_id` has a partial unique index;
   a second `delivered` or a later `read` inserts nothing.
6. **Where the figures show.** The owner's `/usage` screen shows AI and WhatsApp cost per
   business per month against the plan price. A business's `/reports` shows its own costs.

## Consequences

- The table must be updated by hand when Meta publishes a new rate card. The effective
  date is shown on `/usage`.
- Before M5, delivered messages recorded no charge. There is no backfill: no business is
  live yet.
- The marketing cap (principle 10) still counts sent messages, not dollars (ADR 0010).
