-- Zero double bookings (principle 3), enforced by Postgres itself (spec §6). Two active
-- bookings of the same resource can never overlap, whatever the application does. Booking
-- writes catch the violation (SQLSTATE 23P01) and turn it into a typed SlotTaken.
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));
--> statement-breakpoint

-- Row-level security, same pattern as 0002/0004 (ADR 0005).
GRANT SELECT, INSERT, UPDATE ON resources TO app_tenant;
--> statement-breakpoint
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY resources_tenant ON resources
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON closures TO app_tenant;
--> statement-breakpoint
ALTER TABLE closures ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY closures_tenant ON closures
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

-- Bookings are never deleted, only cancelled (history and reports need them).
GRANT SELECT, INSERT, UPDATE ON bookings TO app_tenant;
--> statement-breakpoint
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bookings_tenant ON bookings
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON booking_proposals TO app_tenant;
--> statement-breakpoint
ALTER TABLE booking_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY booking_proposals_tenant ON booking_proposals
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON handoffs TO app_tenant;
--> statement-breakpoint
ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY handoffs_tenant ON handoffs
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

-- Tenants record usage and read their totals; they never edit or delete it.
GRANT SELECT, INSERT ON usage_events TO app_tenant;
--> statement-breakpoint
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY usage_events_tenant ON usage_events
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
