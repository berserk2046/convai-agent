-- Users, memberships, sessions and login attempts are platform-level (ADR 0011): app_tenant
-- gets no grants on them, so a tenant transaction can't read them at all (fail closed).
--
-- The audit log has business rows, written inside the change's own tenant transaction,
-- and platform rows (business_id null), which tenants never see. Same RLS pattern as
-- 0002/0004/0006 (ADR 0005); tenants append and read, never edit or delete.
GRANT SELECT, INSERT ON audit_log TO app_tenant;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_log_tenant ON audit_log
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

-- Bookings confirmed before confirmed_at existed: their last update was the confirmation.
UPDATE bookings SET confirmed_at = updated_at WHERE status = 'confirmed' AND confirmed_at IS NULL;
