import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { businesses } from "./businesses.ts";
import { verticalTemplates } from "./vertical-templates.ts";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const EVAL_MODES = ["live", "replay"] as const;
export type EvalMode = (typeof EVAL_MODES)[number];

export const EVAL_RUN_STATUSES = ["queued", "running", "finished", "error"] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

/**
 * Eval runs of a template version (spec §6, §11). Platform-level, like vertical_templates:
 * no business_id and no tenant grants. The publish gate reads the latest finished live run
 * of the exact upload (`source_sha256`): re-uploading a draft makes older runs stale.
 */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateSlug: text("template_slug").notNull(),
    templateVersion: text("template_version").notNull(),
    /** SHA-256 (hex) of the source YAML that was evaluated. */
    sourceSha256: text("source_sha256").notNull(),
    /** Whose config the scenarios ran with; v1 runs only the template's sample_config. */
    configSource: text("config_source").notNull().default("sample_config"),
    mode: text("mode", { enum: EVAL_MODES }).notNull(),
    runsPerScenario: integer("runs_per_scenario").notNull(),
    status: text("status", { enum: EVAL_RUN_STATUSES }).notNull().default("queued"),
    /** The full report (`EvalReport` in @platform/evals) once finished. */
    results: jsonb("results"),
    /** Scenario runs done so far, for the admin's progress line. */
    progress: jsonb("progress").$type<{ done: number; total: number }>(),
    passRate: numeric("pass_rate", { precision: 5, scale: 4, mode: "number" }),
    criticalPass: boolean("critical_pass"),
    gatePassed: boolean("gate_passed"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    error: text("error"),
    /** Null when started from the CLI. */
    requestedBy: uuid("requested_by").references(() => users.id),
    createdAt: tz("created_at").notNull().defaultNow(),
    startedAt: tz("started_at"),
    finishedAt: tz("finished_at"),
    /** Touched while running; a run whose heartbeat stops is failed by the next poll. */
    heartbeatAt: tz("heartbeat_at"),
  },
  (t) => [
    foreignKey({
      name: "eval_runs_template_fk",
      columns: [t.templateSlug, t.templateVersion],
      foreignColumns: [verticalTemplates.slug, verticalTemplates.version],
    }),
    index("eval_runs_template_idx").on(t.templateSlug, t.templateVersion, t.createdAt),
    index("eval_runs_status_idx").on(t.status),
    check("eval_runs_mode_check", sql`${t.mode} in ('live', 'replay')`),
    check("eval_runs_status_check", sql`${t.status} in ('queued', 'running', 'finished', 'error')`),
    check("eval_runs_runs_check", sql`${t.runsPerScenario} between 1 and 10`),
  ],
);

export type EvalRunRow = typeof evalRuns.$inferSelect;

export const PLAYGROUND_STATUSES = ["active", "closed"] as const;
export type PlaygroundStatus = (typeof PLAYGROUND_STATUSES)[number];

/**
 * Playground chats (spec §11, ADR 0016). Each session has its own scratch database where
 * the agent books, hands off and records usage; this row keeps what the owner sees (the
 * transcript with tool calls and costs), so pages never open the scratch database.
 */
export const playgroundSessions = pgTable(
  "playground_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    databaseName: text("database_name").notNull(),
    templateSlug: text("template_slug").notNull(),
    templateVersion: text("template_version").notNull(),
    /** "sample_config", or "business" with `source_business_id`. */
    configSource: text("config_source").notNull(),
    sourceBusinessId: uuid("source_business_id").references(() => businesses.id),
    /** Whether the playground contact starts with consent given. */
    consentGiven: boolean("consent_given").notNull(),
    status: text("status", { enum: PLAYGROUND_STATUSES }).notNull().default("active"),
    /** Turn records (`PlaygroundEntry[]` in @platform/services), oldest first. */
    entries: jsonb("entries").$type<unknown[]>().notNull().default([]),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    /** Set while a message is being answered: one turn at a time per session. */
    busySince: tz("busy_since"),
    createdAt: tz("created_at").notNull().defaultNow(),
    lastUsedAt: tz("last_used_at").notNull().defaultNow(),
    closedAt: tz("closed_at"),
  },
  (t) => [
    unique("playground_sessions_database_key").on(t.databaseName),
    foreignKey({
      name: "playground_sessions_template_fk",
      columns: [t.templateSlug, t.templateVersion],
      foreignColumns: [verticalTemplates.slug, verticalTemplates.version],
    }),
    check("playground_sessions_status_check", sql`${t.status} in ('active', 'closed')`),
    check(
      "playground_sessions_config_check",
      sql`(${t.configSource} = 'sample_config' and ${t.sourceBusinessId} is null) or (${t.configSource} = 'business' and ${t.sourceBusinessId} is not null)`,
    ),
  ],
);

export type PlaygroundSessionRow = typeof playgroundSessions.$inferSelect;
