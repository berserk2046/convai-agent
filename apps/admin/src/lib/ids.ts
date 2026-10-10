const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params are user input (Next's data security guide): check ids before using them. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
