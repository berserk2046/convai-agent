/**
 * Creates a platform owner, the account that uploads templates and creates businesses.
 * Values come from the environment, never from arguments. To keep the password out of
 * shell history, type it at a prompt:
 *
 *   read -rs OWNER_PASSWORD && export OWNER_PASSWORD
 *   OWNER_EMAIL=you@example.com OWNER_NAME="Your Name" pnpm admin:create-owner
 */
import { InvalidInputError, createDb, pgErrorCode } from "@platform/db";
import { baseEnv, createLogger, databaseEnv, parseEnv } from "@platform/shared";
import { z } from "zod";
import { createOwner } from "../auth.ts";

const env = parseEnv(
  baseEnv.extend(databaseEnv.shape).extend({
    OWNER_EMAIL: z.email(),
    OWNER_NAME: z.string().min(1),
    OWNER_PASSWORD: z.string().min(10, "must be at least 10 characters"),
  }),
);
/** SQLSTATE for a missing table: the database is behind the migrations. */
const UNDEFINED_TABLE = "42P01";

const logger = createLogger({ level: env.LOG_LEVEL, name: "create-owner" });
const { db, close } = createDb(env.DATABASE_URL);
try {
  const user = await createOwner(
    { db },
    { email: env.OWNER_EMAIL, name: env.OWNER_NAME, password: env.OWNER_PASSWORD },
  );
  logger.info({ user_id: user.id, email: user.email }, "platform owner created");
} catch (error) {
  if (error instanceof InvalidInputError) logger.error(error.message);
  else if (pgErrorCode(error) === UNDEFINED_TABLE) {
    logger.error("the users table does not exist: run `pnpm db:migrate` first");
  } else logger.error({ err: error }, "could not create the platform owner");
  process.exitCode = 1;
} finally {
  await close();
}
