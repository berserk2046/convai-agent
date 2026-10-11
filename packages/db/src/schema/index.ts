// Drizzle table definitions. Constraints Drizzle can't express (exclusion, RLS policies,
// grants) go in custom migrations: `pnpm db:new <name>`.
//
// Convention for every new business-owned table: a `business_id uuid not null` column, and
// in a custom migration: GRANT the needed privileges to app_tenant, ENABLE ROW LEVEL
// SECURITY, and a policy on `business_id = app_current_business_id()`. Without the GRANT
// the table is invisible to tenant transactions (fail closed).
export * from "./auth.ts";
export * from "./automations.ts";
export * from "./businesses.ts";
export * from "./messaging.ts";
export * from "./scheduling.ts";
export * from "./vertical-templates.ts";
export * from "./evals.ts";
