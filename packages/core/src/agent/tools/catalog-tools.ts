import { chooseSlots } from "@platform/scheduling";
import { z } from "zod";
import {
  catalogAt,
  describeItem,
  findItem,
  isBookable,
  searchCatalog,
  slotView,
} from "./catalog.ts";
import { durationOf, effectiveRules, searchSlots } from "./slots.ts";
import { toolError, type AgentTool } from "./types.ts";

const isoDate = z.iso
  .date()
  .describe('Local date, "YYYY-MM-DD". Take it from the calendar in the context.');

export const lookupCatalog: AgentTool = {
  name: "lookup_catalog",
  description:
    "Look up the business's services or items: name, price_type, price_cop, duration and description. " +
    "Use it before stating any price or service detail. Search by `query` (words) or exact `key`; " +
    "with neither, returns the whole catalog.",
  input: () =>
    z.strictObject({
      query: z.string().max(100).optional().describe("Words to search for, e.g. 'limpieza'"),
      key: z.string().max(60).optional().describe("Exact item key, if known"),
    }),
  run(ctx, input, params) {
    const catalog = catalogAt(ctx.config, String(params.catalog_path));
    const key = typeof input.key === "string" ? input.key : undefined;
    const query = typeof input.query === "string" ? input.query : undefined;
    const items = key
      ? [findItem(catalog, key)].filter((i) => i !== null)
      : searchCatalog(catalog, query ?? "");
    return Promise.resolve({
      result: { items: items.slice(0, 15).map(describeItem), total: items.length },
    });
  },
};

export const checkAvailability: AgentTool = {
  name: "check_availability",
  description:
    "Find free appointment times for a service between two local dates (inclusive). Always call this " +
    "before offering times. Returns a few well-spread options. If the customer asks for a specific time, " +
    "pass `around_time`: the result says whether exactly that time is free (`exact`) and lists the " +
    "nearest alternatives.",
  input: () =>
    z.strictObject({
      service_key: z.string().describe("Catalog key of the service"),
      date_from: isoDate,
      date_to: isoDate,
      time_of_day: z.enum(["morning", "afternoon", "evening"]).optional(),
      party_size: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Number of people, for reservations"),
      around_time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .optional()
        .describe('A specific local time the customer asked for, "HH:mm"'),
    }),
  async run(ctx, input, params) {
    const rules = effectiveRules(ctx, params);
    const catalog = catalogAt(ctx.config, rules.catalogPath);
    const item = findItem(catalog, String(input.service_key));
    if (!item)
      return toolError("unknown_service", "No service with that key.", {
        known_keys: catalog.map((i) => i.key),
      });
    if (!isBookable(item))
      return toolError(
        "not_bookable",
        "This service can't be booked over WhatsApp; offer a person (handoff) or a related bookable service.",
      );
    const durationMin = durationOf(item, rules);
    if (durationMin === null)
      return toolError("no_duration", "This service has no duration configured.");

    const candidates = await searchSlots(ctx, {
      item,
      rules,
      durationMin,
      dateFrom: String(input.date_from),
      dateTo: String(input.date_to),
      timeOfDay: input.time_of_day as "morning" | "afternoon" | "evening" | undefined,
      partySize: typeof input.party_size === "number" ? input.party_size : undefined,
    });
    const around = typeof input.around_time === "string" ? input.around_time : undefined;
    const offer = chooseSlots(candidates, rules.slotsToOffer, around);
    const exact = offer.exact
      ? candidates.find((c) => c.day === offer.exact?.day && c.minute === offer.exact.minute)
      : undefined;
    return {
      result: {
        service: { key: item.key, name: item.name, duration_min: durationMin },
        slots: offer.slots.map((s) => slotView(s.start, ctx.timezone)),
        ...(offer.exact
          ? {
              exact: {
                time: around,
                available: offer.exact.available,
                ...(exact ? slotView(exact.start, ctx.timezone) : {}),
              },
            }
          : {}),
        ...(offer.slots.length === 0
          ? { note: "Nothing free in that range. Try other dates or times." }
          : {}),
      },
    };
  },
};
