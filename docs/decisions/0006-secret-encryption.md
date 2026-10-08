# 0006 — Secret encryption with node:crypto instead of libsodium

Status: accepted (M2). It deviates from spec §4; the owner can veto it.

## Context

Spec §4 lists libsodium (`libsodium-wrappers`) secretbox for secrets at rest (channel tokens,
later Google credentials). The owner asked for a lean dependency tree that is easy to debug.

## Decision

- **AES-256-GCM from `node:crypto`**, with a 32-byte master key (`ENCRYPTION_KEY`,
  base64). It gives the same guarantees secretbox gives (authenticated encryption) with no
  dependency and no WASM.
- **Format:** `v1.<iv>.<tag>.<ciphertext>` (base64url), with a fresh random 96-bit IV per
  encryption. The version prefix leaves room for key rotation (`v2` with a key id).
- **Associated data binds each ciphertext to its record** (`channel:<phone_number_id>`). A
  sealed token copied onto another channel row fails to decrypt.
- **Only the worker decrypts, right before a send.** The API never needs a token. Errors
  never include key material or ciphertext.

## Consequences

- One less dependency. The code is about 40 lines in `packages/shared/src/secret-box.ts`.
- Random 96-bit IVs are safe far beyond our volume (a few secrets per business).
- If the owner prefers libsodium as written in the spec, only `secret-box.ts` changes.
