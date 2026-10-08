import type { WhatsAppClient } from "@platform/channels";
import type { Database } from "@platform/db";
import type { Logger, SecretBox } from "@platform/shared";

/** What the runtime needs from the outside world; tests swap in fakes. */
export interface CoreDeps {
  db: Database;
  logger: Logger;
  whatsapp: WhatsAppClient;
  secrets: SecretBox;
  now: () => Date;
}
