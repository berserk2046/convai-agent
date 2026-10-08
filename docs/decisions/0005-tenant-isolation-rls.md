# 0005 — Tenant isolation with RLS via SET LOCAL ROLE

Status: accepted (M1)

## Context

Principle 6 needs scoping in code plus row-level security as a second layer. Superusers and
table owners bypass RLS, and the app connects as the owner (it also runs migrations and
cross-tenant jobs).

## Decision

- **A `NOLOGIN` role `app_tenant`** owns nothing and has no `BYPASSRLS`. Tenant work runs
  in `withTenant(db, businessId, fn)`: one transaction with `SET LOCAL ROLE app_tenant` and
  `set_config('app.business_id', id, true)`. Both reset at commit or rollback, so pooled
  connections are never left scoped.
- **Policies compare against `app_current_business_id()`.** It returns null when the
  setting is unset or empty, so nothing matches (fail closed). The business id is checked
  as a UUID before use.
- **Privileges are granted per table, explicitly**, with no default privileges. A new
  table is invisible to tenants until its migration grants access and adds a policy. On
  existing tables:
  - tenants may `SELECT` templates;
  - tenants may `SELECT`/`UPDATE` their own business;
  - tenants may never create businesses.
- **Platform-level work** (template uploads, creating businesses, sweepers, usage reports)
  runs as the owner and scopes in code.
- **Roles are cluster-wide,** so the migration creates `app_tenant` idempotently, which is
  safe when parallel test databases run it.

## Consequences

- Every business-owned table needs, in its migration: `business_id`, a grant to
  `app_tenant`, `ENABLE ROW LEVEL SECURITY`, and a policy. See the comment in
  `packages/db/src/schema/index.ts`.
- Tests prove the second layer works on its own (`tenant.test.ts`): reads without a WHERE
  clause, cross-tenant updates, inserts into platform tables, and the unset-id case.
