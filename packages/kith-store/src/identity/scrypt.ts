// Scrypt, exactly as the stored password hashes were produced.
//
// Today `@convex-dev/auth`'s Password provider calls `new Scrypt()` from
// `lucia@3`, which is `lucia/dist/crypto.js`:
//
//   hash:   salt = hex(16 random bytes)
//           key  = scrypt(utf8(password.normalize("NFKC")), utf8(salt),
//                         { N: 16384, r: 16, p: 1, dkLen: 64 })
//           => `${salt}:${hex(key)}`
//   verify: recompute the key over the stored salt, compare in constant time.
//
// Every one of those five facts has to be reproduced or no existing password
// verifies after cutover, and a wrong one fails closed rather than loudly: the
// owner simply cannot sign in. Two are easy to get wrong and worth naming.
//
//   * The salt fed to scrypt is the UTF-8 bytes of the *hex string*, not the 16
//     bytes it encodes. Decoding it would produce a different key.
//   * r is 16, not the more common 8. `LegacyScrypt`'s two-part branch is the
//     one that uses 8; the provider does not use `LegacyScrypt`.
//
// Node's own `crypto.scrypt` computes this, so nothing here reimplements a KDF.
// It needs `maxmem` raised: 128 * r * (N + p) is 33,556,480 bytes, just over
// Node's 32 MiB default, and lucia passes 1 GiB + 1 KiB. Same value here.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 16_384;
const R = 16;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 1024 ** 3 + 1024;
const SALT_BYTES = 16;

/** `<32 hex salt>:<128 hex key>`, the shape `auth_accounts.secret` holds. */
const STORED = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

async function derive(password: string, saltHex: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      Buffer.from(password.normalize("NFKC"), "utf8"),
      Buffer.from(saltHex, "utf8"),
      KEY_LENGTH,
      { N, r: R, p: P, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** A fresh hash for a new or changed password, in the stored format. */
export async function hashPassword(password: string): Promise<string> {
  const saltHex = randomBytes(SALT_BYTES).toString("hex");
  return `${saltHex}:${(await derive(password, saltHex)).toString("hex")}`;
}

/**
 * Whether `password` produces `stored`. Never throws on a malformed stored
 * value: an account whose secret is missing or corrupt must fail to verify, not
 * raise a different error that a caller might treat differently from a wrong
 * password.
 */
export async function verifyPassword(
  stored: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (typeof stored !== "string" || !STORED.test(stored)) return false;
  const [saltHex, keyHex] = stored.split(":") as [string, string];
  return timingSafeEqual(
    await derive(password, saltHex),
    Buffer.from(keyHex, "hex"),
  );
}
