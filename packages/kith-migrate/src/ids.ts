import { randomBytes } from "node:crypto";

// RFC 4648 base32 alphabet, lowercased, no padding: plan section 2.2's "new
// rows get a generated opaque id, lowercase base32 of 16 random bytes,
// distinguishable by length" (16 bytes -> 26 base32 characters, no `=`).
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh opaque id for a row this migration synthesizes (never a Convex
 * document): the two `apiKeys` grant-array child tables need one per row. */
export function newId(): string {
  return base32(randomBytes(16));
}
