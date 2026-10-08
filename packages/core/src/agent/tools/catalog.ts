import { formatSlotLabel } from "@platform/shared";
import { getPath } from "@platform/templates";
import { DateTime } from "luxon";
import { normalize } from "../guardrails.ts";

/** A catalog item as configured by the business (services, menu items…). */
export type CatalogItem = Record<string, unknown> & { key: string; name: string };

export function catalogAt(config: Record<string, unknown>, path: string): CatalogItem[] {
  const value = getPath(config, path);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is CatalogItem =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as CatalogItem).key === "string" &&
      typeof (item as CatalogItem).name === "string",
  );
}

export function findItem(catalog: readonly CatalogItem[], key: string): CatalogItem | null {
  return catalog.find((item) => item.key === key) ?? null;
}

/** Accent- and case-insensitive word match on key, name and description. */
export function searchCatalog(catalog: readonly CatalogItem[], query: string): CatalogItem[] {
  const words = normalize(query)
    .split(" ")
    .filter((w) => w.length > 2);
  if (words.length === 0) return [...catalog];
  return catalog.filter((item) => {
    const haystack = normalize(
      `${item.key.replaceAll("_", " ")} ${item.name} ${typeof item.description === "string" ? item.description : ""}`,
    );
    return words.some((w) => haystack.includes(w));
  });
}

export function isBookable(item: CatalogItem): boolean {
  return item.bookable !== false;
}

/** What the model sees of an item: facts only, no wording. */
export function describeItem(item: CatalogItem): Record<string, unknown> {
  const { key, name, description, price_type, price_cop, duration_min } = item;
  return {
    key,
    name,
    price_type: price_type ?? null,
    price_cop: price_cop ?? null,
    duration_min: duration_min ?? null,
    description: description ?? null,
    bookable: isBookable(item),
  };
}

/** "2026-10-08T15:00:00-05:00" in the business timezone, plus its Spanish label. */
export function slotView(start: Date, timezone: string): { starts_at: string; label: string } {
  const local = DateTime.fromJSDate(start, { zone: timezone });
  return {
    starts_at: local.toISO({ suppressMilliseconds: true }) ?? "",
    label: formatSlotLabel(local),
  };
}
