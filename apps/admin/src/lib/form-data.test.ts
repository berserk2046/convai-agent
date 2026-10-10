import { describe, expect, it } from "vitest";
import { field, fieldAll } from "./form-data.ts";

describe("field / fieldAll", () => {
  const form = new FormData();
  form.set("name", "Sillón 1");
  form.append("param", "trigger.offset");
  form.append("param", new Blob(["x"]), "x.txt");
  form.set("upload", new Blob(["x"]), "x.txt");

  it("reads text, and files or missing fields as empty", () => {
    expect(field(form, "name")).toBe("Sillón 1");
    expect(field(form, "upload")).toBe("");
    expect(field(form, "missing")).toBe("");
    expect(fieldAll(form, "param")).toEqual(["trigger.offset"]);
  });
});
