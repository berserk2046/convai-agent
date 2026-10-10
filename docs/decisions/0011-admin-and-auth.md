# 0011 — Admin app, auth and the service layer

Status: accepted (M5)

## Sources

- **Next.js 16.3.8**: the docs bundled in `node_modules/next/dist/docs/`, mainly the
  authentication and data-security guides, server functions, `error.js` (its `retry` prop is
  new in 16), and the note that `proxy` replaces middleware.
- **Node `crypto.argon2`** (added in v24.7.0): the Node API docs. The parameters follow OWASP's
  password storage cheat sheet for argon2id: 19 MiB of memory, 2 passes, 1 lane.
- **RJSF 6.11**: the package's own types and README (`customizeValidator`, the field's
  `onChange(value, path)`, `ObjectFieldTemplate`, `ButtonTemplates`, `translateString`).

## Decision

1. **A service layer, `@platform/services`.** Every screen calls plain functions:
   - each takes `(deps, actor, …)`;
   - each checks the role itself;
   - business functions run inside `inBusiness()`, which is `withTenant` plus loading the
     business and an audit helper.

   The admin is a thin shell over the service layer: pages render the results, and server
   actions turn form data into a call and an `ActionState`. So the rules are tested without a
   browser (86 integration tests), and a future API can reuse them.

2. **Data access layer, not proxy or middleware.** Each page and each server action resolves
   the actor from the session cookie (`lib/session.ts`) and checks the role there. Next's
   guides are explicit that layouts and proxy are not a security boundary. `proxy.ts` is not
   used at all.
3. **Tenancy.**
   - The business always comes from the session, never from a URL or a form (principle 6).
   - Ids that arrive in URLs or as bound action arguments (which a user can edit in the
     browser) are checked as UUIDs, and are looked up only inside the tenant transaction.
   - Another tenant's id, a malformed id, and an owner screen opened by a business user all
     give the same "not found" (`cross-tenant.test.ts`). RLS remains the second layer.
4. **Passwords.**
   - argon2id through `node:crypto`, stored as PHC strings, so the parameters can be raised
     later. No native add-on.
   - Minimum 10 characters.
   - Unknown emails still verify against a dummy hash, so response timing doesn't reveal
     which accounts exist.
5. **Sessions are rows, not JWTs.**
   - The cookie holds 32 random bytes. The table stores only `HMAC-SHA256(SESSION_SECRET,
token)`, so a database leak yields no usable cookies.
   - The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
   - Expiry slides over 7 days, extended at most once every 5 minutes. Login rotates the
     session.
   - Removing a membership ends access on the next request. Changing a password ends the
     user's other sessions; an owner's reset ends all of them.
6. **Login rate limit.** Five failures per email, or 30 per IP, within 15 minutes, counted in
   `login_attempts`. The IP is the first `X-Forwarded-For` entry, set by Caddy (M7), which is
   the only way in.
7. **CSRF.** Server actions get Next's built-in Origin/Host check. The session cookie is
   `SameSite=Lax`. There are no state-changing GET routes.
8. **Roles** (spec §12):
   - The platform owner (`users.is_platform_owner`) sees `/templates`, `/businesses` and
     `/usage`.
   - Business admins see `/setup`, `/automations`, `/inbox`, `/bookings` and `/reports`.
     Staff see only `/inbox` and `/bookings`.
   - **Impersonation** is a flag on the owner's own session, not a fake login. It is audited
     at start and stop, every audited action during it carries `impersonating: true`, and a
     banner shows while it lasts.
9. **Audit log** (`audit_log`, spec §13). Each row records who, which business, an action
   such as `config.update` or `booking.move`, and a small payload: ids, keys and changed
   field names, never message text or secrets. The row is written in the same transaction as
   the change. Business rows are under RLS: `app_tenant` may insert and select, nothing else.
10. **The setup form** is generated with RJSF from the pinned template's config schema.
    - The service builds the uiSchema from `x-ui` hints: sections, order, help, textarea,
      table, and a custom weekly-hours field.
    - Field order comes from the template's source YAML, because jsonb doesn't keep key order.
    - Validation runs in the browser for quick feedback and again on the server, which is the
      authority. Server errors show next to their fields.
11. **UI components.** The components follow shadcn/ui's look (Tailwind 4 tokens and class
    recipes) but are vendored as plain elements: native `<select>`, `<details>` and form
    controls, with no Radix and no component library.
12. **The inbox refreshes instantly**, through Postgres notifications and server-sent events.
    This replaced the first version's 15-second polling; see ADR 0013.
13. **Business screens are in Spanish (es-CO); owner screens are in English.** The runtime's
    own handoff reasons and summaries are English in code, so the admin translates them for
    staff (`inbox/labels.ts`). A test fails if the responder gains a summary without a
    Spanish text.
14. **End-to-end smoke test** (`apps/admin/e2e`, Playwright, Chromium only):
    - Playwright starts a fake Graph API on a fixed port. Its recorded requests are readable
      at `/__requests`.
    - It also starts the built admin (`next start`) on a freshly migrated `e2e_admin`
      database, created on the `DATABASE_URL` server.
    - The test drives the full M5 done-when path. Customer messages go through the real
      webhook ingest and the agent pipeline in the test process, with a scripted LLM.
    - Consent is granted directly; the consent exchange has its own tests in core.
    - CI runs the smoke test as a separate job.

## Consequences

- `apps/admin` depends on workspace packages as TypeScript source. Turbopack compiles them,
  so there is still no build step for packages.
- `next build` must not run with `NODE_ENV=development`, which the dev `.env` sets: React's
  prerender breaks. The admin's `build` and `start` scripts set `NODE_ENV=production`.
  `next.config.ts` loads the root `.env` (variables already set win). Next passes Node flags
  to its workers through `NODE_OPTIONS`, which rejects `--env-file-if-exists`, the flag the
  API and the worker use.
- Choices in generated forms and handoff reasons show the names the template gives them
  (ADR 0014; the dental template since 1.1.0).
