import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox } from "./secret-box.ts";

const key = randomBytes(32).toString("base64");
const box = createSecretBox(key);

describe("createSecretBox", () => {
  it("round-trips a secret bound to its context", () => {
    const sealed = box.encrypt("EAAG-token", "channel:106540352242922");
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain("EAAG");
    expect(box.decrypt(sealed, "channel:106540352242922")).toBe("EAAG-token");
  });

  it("uses a fresh nonce every time", () => {
    expect(box.encrypt("same", "c")).not.toBe(box.encrypt("same", "c"));
  });

  it("refuses another record's context, another key, or tampering", () => {
    const sealed = box.encrypt("EAAG-token", "channel:1");
    expect(() => box.decrypt(sealed, "channel:2")).toThrow(/could not be decrypted/);
    expect(() =>
      createSecretBox(randomBytes(32).toString("base64")).decrypt(sealed, "channel:1"),
    ).toThrow(/could not be decrypted/);
    const parts = sealed.split(".");
    // Always a different first character (replacing it with "A" was a no-op 1 time in 64).
    const tag = parts[3] ?? "";
    const flipped = [
      parts[0],
      parts[1],
      parts[2],
      `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`,
    ].join(".");
    expect(() => box.decrypt(flipped, "channel:1")).toThrow();
  });

  it("rejects keys that aren't 32 bytes and unknown formats", () => {
    expect(() => createSecretBox(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => box.decrypt("plaintext-token", "c")).toThrow(/not a sealed secret/);
  });
});
