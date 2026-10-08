CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"template_slug" text NOT NULL,
	"template_version" text NOT NULL,
	"config" jsonb,
	"timezone" text DEFAULT 'America/Bogota' NOT NULL,
	"status" text DEFAULT 'setup' NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_status_check" CHECK ("businesses"."status" in ('setup', 'active', 'paused')),
	CONSTRAINT "businesses_configured_check" CHECK ("businesses"."status" = 'setup' or "businesses"."config" is not null)
);
--> statement-breakpoint
CREATE TABLE "vertical_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"manifest" jsonb NOT NULL,
	"source_yaml" text NOT NULL,
	"eval_report" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "vertical_templates_slug_version_key" UNIQUE("slug","version"),
	CONSTRAINT "vertical_templates_status_check" CHECK ("vertical_templates"."status" in ('draft', 'published', 'deprecated'))
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_template_fk" FOREIGN KEY ("template_slug","template_version") REFERENCES "public"."vertical_templates"("slug","version") ON DELETE no action ON UPDATE no action;