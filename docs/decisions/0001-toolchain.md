# 0001 — Toolchain: TS source packages, Node type stripping, TS 6.0

Status: accepted (M0)

## Context

The spec asks for strict TypeScript on Node 22 with pnpm workspaces and Turborepo. Node 22
reaches end of life on 2027-04-30, so the owner approved **Node 24 LTS** instead (spec
review A1). Three questions follow: how TypeScript runs, which TypeScript version to use,
and how Turbo caches tasks.

## Decision

- **No build step for packages.** Each workspace package exports its TypeScript source
  (`"exports": { ".": "./src/index.ts" }`). Vitest and Next.js compile it themselves.
  Scripts and the api/worker run through **Node's built-in type stripping**, which is on by
  default on Node 24 (`engines.node >= 24`). Verified on Node 22.23, 24 and 26.
- That forces some TS settings: `erasableSyntaxOnly` (no `enum`, `namespace`, parameter
  properties), `verbatimModuleSyntax` (`import type` for types), and
  `allowImportingTsExtensions` with `.ts` specifiers in relative imports. `noEmit` is on
  everywhere.
- **TypeScript 6.0**, not 7. TS 7 (the native port) is released, but typescript-eslint 8
  supports `typescript < 6.1`, and type-aware lint rules matter more to us than compile
  speed. Revisit when typescript-eslint supports TS 7.
- **No tsx, no bundler, no ts-node.** One less layer to debug.
- **Turbo:** `lint` and `typecheck` depend on a `transit` task, so a change in a dependency
  invalidates its dependents' cache even though no package has a build task. `test` is
  never cached, because integration tests depend on database state, not just on files.
  `concurrency` is `50%` of logical CPUs. Each type-aware ESLint or `tsc` process loads the
  whole workspace, and Turbo's default of 10 parallel tasks got them killed for lack of
  memory on a 3 GB, 4-core machine.
- **ESLint:** flat config with `@eslint/js` recommended plus typescript-eslint
  `strictTypeChecked`. No `eslint-config-prettier`: none of the enabled rules is a
  formatting rule, so there is nothing to turn off. Prettier runs separately
  (`pnpm format:check` in CI).
- **pnpm 12:** dependency install scripts are blocked unless allowed. `esbuild` (pulled in
  by drizzle-kit and vitest) is explicitly denied in `pnpm-workspace.yaml`. It works
  without its postinstall, using the platform binary package.

## Consequences

- A fresh clone needs no compile step: `pnpm i` and go.
- We can't use TS-only runtime syntax. Use string unions and `as const` objects instead of
  enums.
- Production images (M7) can run `node apps/api/src/main.ts` directly.
