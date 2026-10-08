import { baseEnv, createLogger, databaseEnv, parseEnv } from "@platform/shared";
import { waitForPostgres } from "../connection.ts";
import { runMigrations } from "../migrate.ts";
import { describeDatabaseUrl } from "../url.ts";

const env = parseEnv(baseEnv.extend(databaseEnv.shape));
const logger = createLogger({ level: env.LOG_LEVEL, name: "db:migrate" });
const target = describeDatabaseUrl(env.DATABASE_URL);

try {
  await waitForPostgres(env.DATABASE_URL);
  await runMigrations(env.DATABASE_URL);
  logger.info({ target }, "migrations applied");
} catch (error) {
  logger.error({ target, err: error }, "migration failed");
  process.exitCode = 1;
}
