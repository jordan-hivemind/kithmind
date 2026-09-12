// The `retained_texts` table's two operations (F1-66): put a retained text in
// the archive, and get one back out by its hash.
//
// Why the archive holds the text at all, and why it is a `bytea` rather than a
// large object, is stated once in pgSchema.ts's `RETAINED_TEXTS` migration.
// What lives here is only the pair of statements, in one place, because three
// callers have to agree on the column list and on the identity a row is keyed
// by: the import and the reparse (run.ts) write it beside the raw-tree file,
// the read surface (mcp/pgRead.ts) reads it to verify a citation, and
// scripts/backfillRetainedTexts.mjs writes the rows an existing raw tree
// already has files for.
//
// This file opens no file and resolves no path. The raw tree writer
// (rawTree.ts) is still the only place in the package that touches node:fs for
// a retained text; the two are addressed by the same sha256, so they name the
// same bytes without either knowing about the other.

import type pg from "pg";

import { sha256HexOf } from "./rawTree.js";

export type RetainedTextWrite = {
  readonly sha256: string;
  /** False when a row with this sha was already on file. Content addressing
   * makes that a no-op rather than a conflict: the bytes cannot differ. */
  readonly inserted: boolean;
};

/** Unicode code points in `bytes` read as UTF-8 -- the unit a
 * `retained_text_span_v1` binding's `start`/`end` offsets are in. */
function codepointLength(bytes: Buffer): number {
  return Array.from(bytes.toString("utf8")).length;
}

/**
 * Stores one retained text, keyed on its own sha256. Idempotent on that sha,
 * so a document re-acquired, re-parsed or re-backfilled writes nothing the
 * second time and never conflicts: two texts with the same hash are the same
 * text.
 */
export async function storeRetainedTextBytes(
  client: pg.ClientBase,
  content: Buffer,
): Promise<RetainedTextWrite> {
  const sha256 = sha256HexOf(content);
  const written = await client.query(
    `INSERT INTO retained_texts (sha256, byte_length, codepoint_length, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sha256) DO NOTHING`,
    [sha256, content.byteLength, codepointLength(content), content],
  );
  return { sha256, inserted: written.rowCount === 1 };
}

/**
 * The same, for the extracted text an adapter hands back as a string. UTF-8 is
 * the encoding `writeRetainedText` hashes and writes the file under, so this
 * lands the identical bytes under the identical sha.
 */
export async function storeRetainedText(
  client: pg.ClientBase,
  text: string,
): Promise<RetainedTextWrite> {
  return storeRetainedTextBytes(client, Buffer.from(text, "utf8"));
}

/**
 * The stored bytes for `sha256`, or null when the archive has no row for it.
 *
 * Deliberately unverified: the caller recomputes the hash. Verification has
 * to cover the raw-tree fallback as well, so it lives once in the verifier
 * (`verifiedAgainstRetainedText`, mcp/pgRead.ts) rather than half here.
 */
export async function selectRetainedText(
  client: pg.ClientBase,
  sha256: string,
): Promise<Buffer | null> {
  const found = await client.query<{ content: Buffer }>(
    "SELECT content FROM retained_texts WHERE sha256 = $1",
    [sha256],
  );
  return found.rows[0]?.content ?? null;
}
