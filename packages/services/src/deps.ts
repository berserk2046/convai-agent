import type { WhatsAppClient } from "@platform/channels";
import type { Database } from "@platform/db";
import type { Logger, SecretBox } from "@platform/shared";

/** What the admin's service layer needs; tests swap in fakes. */
export interface ServiceDeps {
  db: Database;
  logger: Logger;
  /** Channel tokens: sealed when a channel is connected, opened to send staff replies. */
  secrets: SecretBox;
  whatsapp: WhatsAppClient;
  now: () => Date;
  /** Key for session token HMACs (SESSION_SECRET). */
  sessionSecret: string;
  /** Monthly marketing-message cap for businesses without their own (MARKETING_MSGS_MONTH). */
  marketingMsgsMonth: number;
}
