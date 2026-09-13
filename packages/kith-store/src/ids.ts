// The id convention: preserved text keys, not renumbered uuids.
//
// Section 2.2 of docs/plans/2026-09-12-postgres-consolidation.md fixes this and
// it is not a stylistic choice. The always-on host stores backend ids on disk
// (`archiveCatalogTypes.ts` persists sourceItemId, sourceRevisionId, jobId and
// six more as opaque strings) and historical citations returned over MCP carry
// the same strings. Renumbering would either dangle every one of those or need
// a mapping table consulted on every read forever.
//
// So a migrated row keeps its Convex id verbatim and a new row gets a fresh
// opaque id from `newKithId`. The two are distinguishable by length, which is
// how a row's provenance stays readable without a column to say so.
//
// `migrations/003_kith_id.sql` carries the same rule as a Postgres domain. Both
// have to accept both shapes, so the check is a length range and a character
// class rather than a fixed length. Keep them in step: `KITH_ID` below and the
// domain's CHECK are one convention written twice, once for each side of the
// driver, and `test/kithSchema.test.mjs` asserts they agree.

import { randomBytes } from "node:crypto";

import { ProofError } from "./errors.js";

/**
 * What a kith primary key may look like. Wide enough for a preserved Convex id
 * and for a generated one, narrow enough that a path, an email, an empty string
 * or a mixed-case near-miss is not a key.
 */
export const KITH_ID = /^[a-z0-9]{20,64}$/;

/** Bytes of randomness behind a generated id. 128 bits, so no birthday bound
 * worth reasoning about at this corpus size. */
const ID_BYTES = 16;

/** RFC 4648 base32, lowercased. No padding, so the id is one word. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Length every generated id has: ceil(128 / 5). */
export const GENERATED_KITH_ID_LENGTH = 26;

/**
 * A fresh opaque id for a row this system creates rather than imports.
 *
 * Lowercase base32 of 16 random bytes: case-insensitive, double-click
 * selectable, safe in a URL and in a file name, and distinguishable by length
 * from the 32-character ids the migration preserves.
 */
export function newKithId(): string {
  const bytes = randomBytes(ID_BYTES);
  let bits = 0;
  let accumulator = 0;
  let id = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32[(accumulator >>> bits) & 31];
    }
  }
  // 128 bits is not a multiple of 5, so the last 3 bits become one more
  // character rather than being dropped.
  if (bits > 0) id += BASE32[(accumulator << (5 - bits)) & 31];
  return id;
}

/**
 * The one place an id crossing into SQL is checked. Throws rather than
 * returning a boolean: an id that fails this is a bug or an attack, never a
 * value to carry forward and let the database refuse later.
 */
export function assertKithId(value: unknown, code = "invalid_id"): string {
  if (typeof value !== "string" || !KITH_ID.test(value)) {
    throw new ProofError(code);
  }
  return value;
}
