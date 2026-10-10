/**
 * Reading submitted forms. FormData values can be files as well as text; a file (or a
 * missing field) where text is expected reads as "".
 */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** Every text value of a repeated field. */
export function fieldAll(form: FormData, name: string): string[] {
  return form.getAll(name).filter((value): value is string => typeof value === "string");
}
