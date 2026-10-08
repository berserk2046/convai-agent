import type { SecretBox } from "@platform/shared";
import { and, eq } from "drizzle-orm";
import { InvalidInputError } from "../errors.ts";
import { channels, type ChannelRow } from "../schema/index.ts";
import type { Executor } from "../tenant.ts";

/** Associated data for a channel token: binds the ciphertext to its phone number. */
export function channelTokenContext(phoneNumberId: string): string {
  return `channel:${phoneNumberId}`;
}

export interface CreateChannelInput {
  businessId: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhone: string;
  /** Plain access token; encrypted before it touches the database. */
  accessToken: string;
}

/** Platform-owner action (v1: manual entry of Meta ids and token, spec §12). */
export async function createChannel(
  db: Executor,
  secrets: SecretBox,
  input: CreateChannelInput,
): Promise<ChannelRow> {
  const issues = [
    ...(/^\d+$/.test(input.phoneNumberId)
      ? []
      : [{ path: "phoneNumberId", message: "must be Meta's numeric id" }]),
    ...(/^\d+$/.test(input.wabaId)
      ? []
      : [{ path: "wabaId", message: "must be Meta's numeric id" }]),
    ...(input.displayPhone.trim() === ""
      ? [{ path: "displayPhone", message: "must not be empty" }]
      : []),
    ...(input.accessToken.trim() === ""
      ? [{ path: "accessToken", message: "must not be empty" }]
      : []),
  ];
  if (issues.length > 0) throw new InvalidInputError("channel", issues);

  const [row] = await db
    .insert(channels)
    .values({
      businessId: input.businessId,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      displayPhone: input.displayPhone.trim(),
      tokenEncrypted: secrets.encrypt(
        input.accessToken.trim(),
        channelTokenContext(input.phoneNumberId),
      ),
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/**
 * Resolves a webhook's `metadata.phone_number_id` to its business. Runs before any tenant
 * is known, so it's a platform-level lookup; everything after it is tenant-scoped.
 */
export async function findActiveChannelByPhoneNumberId(
  db: Executor,
  phoneNumberId: string,
): Promise<ChannelRow | null> {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.phoneNumberId, phoneNumberId), eq(channels.status, "active")));
  return row ?? null;
}

export async function getActiveChannel(
  db: Executor,
  businessId: string,
): Promise<ChannelRow | null> {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.businessId, businessId), eq(channels.status, "active")));
  return row ?? null;
}

/** Decrypts the token for one send. Never store or log the result. */
export function channelAccessToken(channel: ChannelRow, secrets: SecretBox): string {
  return secrets.decrypt(channel.tokenEncrypted, channelTokenContext(channel.phoneNumberId));
}

/** Replaces a channel's access token (e.g. Meta's 24-hour test tokens, or a rotated one). */
export async function updateChannelToken(
  db: Executor,
  secrets: SecretBox,
  channel: ChannelRow,
  accessToken: string,
): Promise<void> {
  if (accessToken.trim() === "")
    throw new InvalidInputError("channel", [{ path: "accessToken", message: "must not be empty" }]);
  await db
    .update(channels)
    .set({
      tokenEncrypted: secrets.encrypt(
        accessToken.trim(),
        channelTokenContext(channel.phoneNumberId),
      ),
    })
    .where(eq(channels.id, channel.id));
}

export async function disableChannel(db: Executor, channelId: string): Promise<void> {
  await db.update(channels).set({ status: "disabled" }).where(eq(channels.id, channelId));
}
