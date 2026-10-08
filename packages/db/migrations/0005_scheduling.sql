CREATE TABLE "booking_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"action" text NOT NULL,
	"params" jsonb NOT NULL,
	"turn_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "booking_proposals_action_check" CHECK ("booking_proposals"."action" in ('book', 'reschedule', 'cancel'))
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"service_key" text NOT NULL,
	"service_name" text NOT NULL,
	"price_cop" integer,
	"subject_name" text NOT NULL,
	"party_size" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"external_ref" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rescheduled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bookings_range_check" CHECK ("bookings"."ends_at" > "bookings"."starts_at"),
	CONSTRAINT "bookings_status_check" CHECK ("bookings"."status" in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
	CONSTRAINT "bookings_source_check" CHECK ("bookings"."source" in ('agent', 'staff', 'external')),
	CONSTRAINT "bookings_party_size_check" CHECK ("bookings"."party_size" is null or "bookings"."party_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"resource_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "closures_range_check" CHECK ("closures"."ends_at" > "closures"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"summary" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emergency_replied_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"capacity" integer,
	"schedule" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_capacity_check" CHECK ("resources"."capacity" is null or "resources"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"units" integer NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_kind_check" CHECK ("usage_events"."kind" in ('wa_service', 'wa_utility', 'wa_marketing', 'wa_auth', 'llm'))
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "consent_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_proposals" ADD CONSTRAINT "booking_proposals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_proposals" ADD CONSTRAINT "booking_proposals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "closures" ADD CONSTRAINT "closures_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_proposals_conversation_idx" ON "booking_proposals" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "bookings_business_starts_idx" ON "bookings" USING btree ("business_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_contact_starts_idx" ON "bookings" USING btree ("contact_id","starts_at");--> statement-breakpoint
CREATE INDEX "closures_business_range_idx" ON "closures" USING btree ("business_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_one_open_per_conversation" ON "handoffs" USING btree ("conversation_id") WHERE "handoffs"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "resources_business_kind_idx" ON "resources" USING btree ("business_id","kind");--> statement-breakpoint
CREATE INDEX "usage_events_business_at_idx" ON "usage_events" USING btree ("business_id","at");