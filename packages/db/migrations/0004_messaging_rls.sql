-- Row-level security for the messaging tables (ADR 0005). Same pattern as businesses:
-- explicit grants to app_tenant, policies on business_id = app_current_business_id().

-- Channels are created and changed by the platform owner; tenants (the worker sending on a
-- business's behalf, the admin showing its number) only read their own.
GRANT SELECT ON channels TO app_tenant;
--> statement-breakpoint
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY channels_tenant ON channels
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON contacts TO app_tenant;
--> statement-breakpoint
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY contacts_tenant ON contacts
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON conversations TO app_tenant;
--> statement-breakpoint
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY conversations_tenant ON conversations
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

-- No DELETE for tenants: message text is purged by the retention job (platform level).
GRANT SELECT, INSERT, UPDATE ON messages TO app_tenant;
--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY messages_tenant ON messages
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
