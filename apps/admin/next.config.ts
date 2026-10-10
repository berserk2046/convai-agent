import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// The apps share the root .env, as the API and the worker do with `--env-file-if-exists`
// (Next passes Node flags to its workers via NODE_OPTIONS, which rejects that one).
// Variables already set win: production and the e2e run set everything themselves.
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(rootEnv, "utf8")))) {
    process.env[key] ??= value;
  }
}

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source; Turbopack compiles them (no build step).
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
