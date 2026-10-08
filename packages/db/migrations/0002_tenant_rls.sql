-- Tenant isolation, second layer (principle 6, spec §13). Application code always scopes
-- queries by business_id; these policies make a forgotten WHERE clause return nothing
-- instead of another tenant's rows.
--
-- Tenant work runs inside withTenant() (src/tenant.ts): SET LOCAL ROLE app_tenant plus
-- set_config('app.business_id', <id>, true). app_tenant owns no tables and has no
-- BYPASSRLS, so policies apply. An unset or empty app.business_id matches nothing.
-- Platform-level work (migrations, cross-tenant jobs, platform-owner screens) runs as the
-- owner role and scopes in code.

-- Roles are cluster-wide; another database (e.g. a parallel test database) may have
-- created it already.
DO $$
BEGIN
  CREATE ROLE app_tenant NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END $$;
--> statement-breakpoint

-- The connecting role must be able to SET ROLE app_tenant (superusers always can).
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'app_tenant', 'MEMBER') THEN
    EXECUTE format('GRANT app_tenant TO %I', current_user);
  END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION app_current_business_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.business_id', true), '')::uuid $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_tenant;
--> statement-breakpoint

-- Templates are platform data: tenants read their pinned version, never write.
GRANT SELECT ON vertical_templates TO app_tenant;
--> statement-breakpoint

-- Tenants read and update their own business; creating or deleting one is platform work.
GRANT SELECT, UPDATE ON businesses TO app_tenant;
--> statement-breakpoint
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY businesses_tenant ON businesses
  USING (id = app_current_business_id())
  WITH CHECK (id = app_current_business_id());
