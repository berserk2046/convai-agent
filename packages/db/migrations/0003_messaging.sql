CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"provider" text DEFAULT 'whatsapp_cloud' NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" text NOT NULL,
	"display_phone" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_phone_number_id_unique" UNIQUE("phone_number_id"),
	CONSTRAINT "channels_status_check" CHECK ("channels"."status" in ('active', 'disabled')),
	CONSTRAINT "channels_provider_check" CHECK ("channels"."provider" in ('whatsapp_cloud'))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"wa_number" text NOT NULL,
	"name" text,
	"wa_profile_name" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_at" timestamp with time zone,
	"consent_source" text,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_business_wa_number_key" UNIQUE("business_id","wa_number"),
	CONSTRAINT "contacts_consent_source_check" CHECK ("contacts"."consent_source" in ('whatsapp', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"mode" text DEFAULT 'bot' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_contact_id_unique" UNIQUE("contact_id"),
	CONSTRAINT "conversations_mode_check" CHECK ("conversations"."mode" in ('bot', 'human'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"type" text NOT NULL,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wa_message_id" text,
	"status" text NOT NULL,
	"status_at" timestamp with time zone,
	"wa_timestamp" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"idempotency_key" text,
	"send_attempted_at" timestamp with time zone,
	"pricing" jsonb,
	"error" jsonb,
	"tool_calls" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_wa_message_id_unique" UNIQUE("wa_message_id"),
	CONSTRAINT "messages_business_idempotency_key" UNIQUE("business_id","idempotency_key"),
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" in ('received', 'pending', 'sent', 'delivered', 'read', 'played', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_one_active_per_business" ON "channels" USING btree ("business_id") WHERE "channels"."status" = 'active';--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_unprocessed_inbound_idx" ON "messages" USING btree ("conversation_id") WHERE "messages"."direction" = 'inbound' and "messages"."processed_at" is null;