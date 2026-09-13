// Small shared plumbing every provenance and documents function uses.
//
// Convex's `ctx.db.get`/`ctx.db.query(...).collect()` return a whole
// `Doc<"table">`, camelCase, with `_id`/`_creationTime` folded in. The
// Postgres equivalent is `SELECT *` (node-pg already parses `timestamptz` to
// `Date` and `jsonb` to a plain object, so those need no per-column
// conversion) followed by one generic snake_case-to-camelCase rename --
// which is what `camelize` is for, rather than a hand-written mapper per
// table. `id` and `space_id` are not renamed: they are already the field
// names every ported type uses in place of Convex's `_id`/`spaceId`.

/**
 * One column-name rewrite, shared by every ported table's row type.
 *
 * Every Convex `v.number()` column in migration 004's generated DDL is SQL
 * `numeric`, not `integer` (the declarative table list types every ref,
 * ordinal, byte-length and epoch column the same permissive way -- see
 * `packages/kith-migrate/src/schema.ts`'s own note that structural fidelity,
 * not the final column type, was that row's job). node-pg parses `numeric`
 * as a string by default, deliberately: `@repo/finance-contract` depends on
 * that for exact decimal amounts elsewhere in this schema, so this package
 * must not override the driver's global type parser for OID 1700 the way it
 * could for a package with no money columns. `numericFields` is this
 * function's local, per-call alternative: the camelCase names of the columns
 * a given row actually uses as a JS `number` (an ordinal, a byte length, an
 * epoch -- every one of them a Convex `v.number()`, which is a float64, so
 * `Number()` loses nothing `numeric` could represent that Convex could not).
 */
export function camelize<T>(
  row: Record<string, unknown>,
  numericFields: readonly string[] = [],
): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z0-9])/g, (_, c: string) =>
      c.toUpperCase(),
    );
    out[camel] = value;
  }
  for (const field of numericFields) {
    const value = out[field];
    if (value !== null && value !== undefined) out[field] = Number(value);
  }
  return out as T;
}

/**
 * Ported from provenance/model.ts. Convex's V8 runtime has global `crypto`;
 * Node's `globalThis.crypto` (stable since Node 19) is the same Web Crypto
 * API, so this function's body is unchanged.
 */
export async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** A Convex `v.number()` millisecond timestamp, at the Postgres boundary
 * where the column is `timestamptz`: every ported function takes and returns
 * a `Date` for such a field rather than round-tripping through a number, the
 * natural type node-pg already gives a `timestamptz` column. */
export function requireFiniteTimestamp(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${label} must be a valid timestamp`);
  }
}
