import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for secrets at rest (channel access tokens, calendar
 * credentials). AES-256-GCM from node:crypto with a 32-byte master key (ENCRYPTION_KEY).
 * See docs/decisions/0006-secret-encryption.md for why this replaces libsodium.
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>", base64url parts. `context` is bound as associated
 * data, so a ciphertext copied onto another record fails to decrypt.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export interface SecretBox {
  encrypt(plaintext: string, context: string): string;
  decrypt(sealed: string, context: string): string;
}

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes, base64-encoded");

  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(Buffer.from(context, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv, tag, ciphertext]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },

    decrypt(sealed, context) {
      const [version, iv, tag, ciphertext] = sealed.split(".");
      if (
        version !== VERSION ||
        iv === undefined ||
        tag === undefined ||
        ciphertext === undefined
      ) {
        throw new Error("not a sealed secret (unknown format or version)");
      }
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      try {
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Never include key material or ciphertext in the error.
        throw new Error("secret could not be decrypted (wrong key, wrong context, or tampered)");
      }
    },
  };
}
