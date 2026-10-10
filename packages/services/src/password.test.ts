import { describe, expect, it } from "vitest";
import { DUMMY_HASH, hashPassword, passwordProblem, verifyPassword } from "./password.ts";

describe("passwords (argon2id)", () => {
  it("hashes to a PHC string that verifies only the same password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[\w+/]+\$[\w+/]+$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await hashPassword("correct horse battery")).not.toBe(hash); // fresh salt
  });

  it("rejects malformed hashes and verifies against the dummy without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything at all", DUMMY_HASH)).toBe(false);
  });

  it("asks for at least 10 characters", () => {
    expect(passwordProblem("corta")).toMatch(/10 caracteres/);
    expect(passwordProblem("suficientemente larga")).toBeNull();
  });
});
