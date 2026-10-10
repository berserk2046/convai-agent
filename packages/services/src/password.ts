import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with Node's built-in argon2id (node:crypto, Node ≥ 24.7), so no native
 * add-on is needed. Parameters follow OWASP's recommendation for argon2id (19 MiB memory,
 * 2 passes, 1 lane). Hashes are stored as PHC strings, which carry their own parameters,
 * so they can be raised later without breaking existing hashes.
 */

const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Rules for new passwords (Spanish: shown to business users as-is). */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "La contraseña debe tener al menos 10 caracteres.";
  if (password.length > 200) return "La contraseña es demasiado larga.";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const match = PHC.exec(phc);
  if (!match) return false;
  const [, m = "", t = "", p = "", salt = "", hash = ""] = match;
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A valid hash of a random password: lets a login for an unknown email cost the same time. */
export const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Xhb0Gk6Wj6zT5u3nZp1cS2y3tqJm9mJ0bU7m1f9Yb0Y";

function derive(
  password: string,
  salt: Buffer,
  params: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: password, nonce: salt, ...params }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** PHC strings use standard base64 without padding. */
function b64(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=+$/, "");
}
