import { openHandoff, setContactFields, withTenant } from "@platform/db";
import { SYSTEM_HANDOFF_REASONS } from "@platform/templates";
import { z } from "zod";
import { toolError, type AgentTool } from "./types.ts";

/** Reasons the model may choose: the template's, minus the ones only the runtime uses (B18). */
export function modelHandoffReasons(params: Record<string, unknown>): string[] {
  const reasons = Array.isArray(params.reasons) ? (params.reasons as string[]) : [];
  return reasons.filter((r) => !(SYSTEM_HANDOFF_REASONS as readonly string[]).includes(r));
}

export const handoff: AgentTool = {
  name: "handoff",
  description:
    "Hand the conversation to a person on the team. Use it when the customer asks for a person, complains, asks " +
    "something clinical or anything you can't answer from the business data, or when you can't solve it after two " +
    "tries. Afterwards the system tells the customer a person will reply; don't promise times yourself.",
  input: (ctx) => {
    const reasons = modelHandoffReasons(ctx.prepared.template.agent.tools.handoff ?? {});
    return z.strictObject({
      reason: z.enum(reasons as [string, ...string[]]),
      summary: z
        .string()
        .max(500)
        .describe("One or two sentences for the team: what the customer needs"),
    });
  },
  async run(ctx, input) {
    const reason = String(input.reason);
    await withTenant(ctx.db, ctx.business.id, (tx) =>
      openHandoff(tx, {
        businessId: ctx.business.id,
        conversationId: ctx.conversation.id,
        reason,
        summary: typeof input.summary === "string" ? input.summary : null,
      }),
    );
    ctx.logger.info(
      { business_id: ctx.business.id, conversation_id: ctx.conversation.id, reason },
      "handoff opened",
    );
    return { result: { status: "handed_off" }, handoff: { reason } };
  },
};

export const updateContact: AgentTool = {
  name: "update_contact",
  description:
    "Save a fact about the customer in one of the allowed fields (for example a pet's name).",
  input: (ctx) => {
    const fields = ctx.prepared.template.agent.tools.update_contact?.writable_fields;
    const allowed = Array.isArray(fields) ? (fields as string[]) : [];
    return z.strictObject({
      field: z.enum(allowed as [string, ...string[]]),
      value: z.union([z.string().max(200), z.number(), z.boolean()]),
    });
  },
  async run(ctx, input) {
    const compiled = ctx.prepared.contactFields;
    if (!compiled) return toolError("no_contact_fields", "This business has no contact fields.");
    const fields = { ...ctx.contact.fields, [String(input.field)]: input.value };
    if (!compiled.validate(structuredClone(fields))) {
      return toolError("invalid_value", "That value doesn't fit the field.", {
        details: compiled.validate.errors?.[0]?.message ?? null,
      });
    }
    const updated = await withTenant(ctx.db, ctx.business.id, (tx) =>
      setContactFields(tx, ctx.contact.id, fields),
    );
    // A second update in the same turn must build on this one, not on the stale row.
    if (updated) ctx.contact = updated;
    return { result: { status: "updated" } };
  },
};
