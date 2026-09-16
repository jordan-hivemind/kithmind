// The opaque `(created_at, id)` cursor every paged read in this package uses.
//
// One helper rather than a spelling per call site, because the thing that went
// wrong is invisible at a call site. `created_at` is `timestamptz`, which
// PostgreSQL stores to the microsecond. `node-postgres` parses it into a
// JavaScript `Date`, which holds milliseconds. A cursor built from
// `row.created_at.toISOString()` is therefore up to 999 microseconds *earlier*
// than the row it names, and `(created_at, id) > ($n, $m)` selects that row
// again: the next page repeats the previous one, forever, and every row after
// it is unreachable. It is silent, it only appears on a second page, and it
// only appears when the stored timestamp has a non-zero microsecond part, which
// is almost always and never in a hand-built fixture that used a whole number
// of milliseconds.
//
// So the boundary never goes through `Date`. The query asks PostgreSQL to
// render the timestamp as text with microseconds (`US`) in UTC, that exact text
// is what the cursor carries, and it is bound back as text and cast with
// `::timestamptz`. Rendering is `to_char` with an explicit `AT TIME ZONE 'UTC'`
// rather than `::text`, because `::text` formats in the session's `TimeZone`
// and a cursor must not depend on which backend served the previous page.
//
// The cursor stays opaque to callers: base64url over a two-element JSON array,
// which is the encoding `documents/inventory.ts` already published, so a cursor
// issued before this change still parses. It decodes to a different timestamp
// spelling, which is the point.

/**
 * The keyset timestamp column, rendered for a cursor.
 *
 * `column` and `alias` are identifiers and must be literals in the calling
 * module. Nothing from a request is ever passed here.
 */
export function keysetCursorColumn(
  column = "created_at",
  alias = "keyset_at",
): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`;
}

/** The comparison a keyset page applies, with the two bind positions. */
export function keysetCursorPredicate(
  timestampPosition: number,
  idPosition: number,
  column = "created_at",
  idColumn = "id",
): string {
  return `(${column}, ${idColumn}) > ($${timestampPosition}::timestamptz, $${idPosition})`;
}

/** The text the cursor carries, exactly as PostgreSQL rendered it. */
export function encodeKeysetCursor(keysetAt: string, id: string): string {
  if (typeof keysetAt !== "string" || typeof id !== "string") {
    throw new Error("Keyset cursor needs a rendered timestamp and an id");
  }
  return Buffer.from(JSON.stringify([keysetAt, id]), "utf8").toString(
    "base64url",
  );
}

/**
 * The two values back, validated.
 *
 * A malformed cursor is refused rather than bound: the timestamp is about to
 * be cast by the server, and an unparseable one would otherwise surface as a
 * raw PostgreSQL error on a tool response.
 */
export function decodeKeysetCursor(cursor: string): {
  keysetAt: string;
  id: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(parsed[0])
  ) {
    throw new Error("Invalid cursor");
  }
  return { keysetAt: parsed[0], id: parsed[1] };
}
