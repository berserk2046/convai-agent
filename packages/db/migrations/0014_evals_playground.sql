-- Eval runs and playground sessions (M6, ADR 0015/0016) are platform-level: app_tenant gets
-- no grants on them, so tenant transactions cannot see them (fail closed, like users).
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_slug" text NOT NULL,
	"template_version" text NOT NULL,
	"source_sha256" text NOT NULL,
	"config_source" text DEFAULT 'sample_config' NOT NULL,
	"mode" text NOT NULL,
	"runs_per_scenario" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"results" jsonb,
	"progress" jsonb,
	"pass_rate" numeric(5, 4),
	"critical_pass" boolean,
	"gate_passed" boolean,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	CONSTRAINT "eval_runs_mode_check" CHECK ("eval_runs"."mode" in ('live', 'replay')),
	CONSTRAINT "eval_runs_status_check" CHECK ("eval_runs"."status" in ('queued', 'running', 'finished', 'error')),
	CONSTRAINT "eval_runs_runs_check" CHECK ("eval_runs"."runs_per_scenario" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "playground_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"database_name" text NOT NULL,
	"template_slug" text NOT NULL,
	"template_version" text NOT NULL,
	"config_source" text NOT NULL,
	"source_business_id" uuid,
	"consent_given" boolean NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"busy_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "playground_sessions_database_key" UNIQUE("database_name"),
	CONSTRAINT "playground_sessions_status_check" CHECK ("playground_sessions"."status" in ('active', 'closed')),
	CONSTRAINT "playground_sessions_config_check" CHECK (("playground_sessions"."config_source" = 'sample_config' and "playground_sessions"."source_business_id" is null) or ("playground_sessions"."config_source" = 'business' and "playground_sessions"."source_business_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_template_fk" FOREIGN KEY ("template_slug","template_version") REFERENCES "public"."vertical_templates"("slug","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_source_business_id_businesses_id_fk" FOREIGN KEY ("source_business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_template_fk" FOREIGN KEY ("template_slug","template_version") REFERENCES "public"."vertical_templates"("slug","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_runs_template_idx" ON "eval_runs" USING btree ("template_slug","template_version","created_at");--> statement-breakpoint
CREATE INDEX "eval_runs_status_idx" ON "eval_runs" USING btree ("status");