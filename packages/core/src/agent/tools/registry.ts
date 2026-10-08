import { TOOLS, type ToolName } from "@platform/templates";
import { book, cancel, findBookings, reschedule } from "./booking-tools.ts";
import { checkAvailability, lookupCatalog } from "./catalog-tools.ts";
import { handoff, updateContact } from "./other-tools.ts";
import type { AgentTool } from "./types.ts";

/**
 * Implementations of every tool the template layer declares (packages/templates
 * capabilities.ts). The `Record<ToolName, …>` type makes a missing one a compile error.
 */
export const AGENT_TOOLS: Record<ToolName, AgentTool> = {
  lookup_catalog: lookupCatalog,
  check_availability: checkAvailability,
  book,
  find_bookings: findBookings,
  reschedule,
  cancel,
  handoff,
  update_contact: updateContact,
};

/** Tools disabled until the contact gives consent (spec §7, step 3). */
export function requiresConsent(name: ToolName): boolean {
  return TOOLS[name].requiresConsent;
}
