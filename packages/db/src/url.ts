/** `host:port/database`, safe to log: no user or password. */
export function describeDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
}

/** The same server and credentials, pointed at another database. */
export function withDatabaseName(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
