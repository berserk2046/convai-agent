-- Row-level security for the automation tables, same pattern as 0002/0004/0006 (ADR 0005).
-- Business admins toggle rules and tenants record runs, templates and notifications; none
-- of these rows are ever deleted (history and reports need them).
GRANT SELECT, INSERT, UPDATE ON automations TO app_tenant;
--> statement-breakpoint
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automations_tenant ON automations
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON automation_runs TO app_tenant;
--> statement-breakpoint
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automation_runs_tenant ON automation_runs
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON wa_message_templates TO app_tenant;
--> statement-breakpoint
ALTER TABLE wa_message_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY wa_message_templates_tenant ON wa_message_templates
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON staff_notifications TO app_tenant;
--> statement-breakpoint
ALTER TABLE staff_notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_notifications_tenant ON staff_notifications
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());
--> statement-breakpoint

-- Businesses created before automations existed get their template's rules, with each
-- rule's default_enabled. New businesses get them from createBusiness().
INSERT INTO automations (business_id, rule_key, enabled)
SELECT b.id, rule->>'key', coalesce((rule->>'default_enabled')::boolean, false)
FROM businesses b
JOIN vertical_templates t ON t.slug = b.template_slug AND t.version = b.template_version
CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.manifest->'automations', '[]'::jsonb)) AS rule
ON CONFLICT DO NOTHING;
