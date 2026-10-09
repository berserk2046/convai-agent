CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"occurrence_key" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"sent_message_id" uuid,
	"reason" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "automation_runs_occurrence_key" UNIQUE("automation_id","subject_type","subject_id","occurrence_key"),
	CONSTRAINT "automation_runs_status_check" CHECK ("automation_runs"."status" in ('scheduled', 'sent', 'skipped', 'failed')),
	CONSTRAINT "automation_runs_subject_type_check" CHECK ("automation_runs"."subject_type" in ('booking', 'contact', 'conversation', 'business'))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_business_rule_key" UNIQUE("business_id","rule_key")
);
--> statement-breakpoint
CREATE TABLE "staff_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "staff_notifications_dedupe_key" UNIQUE("business_id","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "wa_message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"meta_name" text NOT NULL,
	"language" text NOT NULL,
	"category_requested" text NOT NULL,
	"category_meta" text,
	"components" jsonb NOT NULL,
	"submitted_components" jsonb,
	"meta_template_id" text,
	"meta_status" text,
	"rejected_reason" text,
	"status_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"status_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_message_templates_name_language" UNIQUE("business_id","meta_name","language")
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_sent_message_id_messages_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_message_templates" ADD CONSTRAINT "wa_message_templates_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_scheduled_due_idx" ON "automation_runs" USING btree ("due_at") WHERE "automation_runs"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "automation_runs_subject_idx" ON "automation_runs" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "staff_notifications_business_created_idx" ON "staff_notifications" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "wa_message_templates_meta_id_idx" ON "wa_message_templates" USING btree ("meta_template_id");--> statement-breakpoint
CREATE INDEX "messages_business_templates_idx" ON "messages" USING btree ("business_id","created_at") WHERE "messages"."type" = 'template';