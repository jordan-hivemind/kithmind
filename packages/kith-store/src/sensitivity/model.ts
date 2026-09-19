// The levels, and the one opt-in restriction expressed in terms of them.
//
// Read migration 029's header first: the owner's decision on 2026-09-19 is that
// nothing may stand between him, or an assistant he connected, and his own
// data. So a level is a LABEL. On its own it withholds nothing from anyone, and
// `applyCeiling` below is the only function in the codebase that can drop a row
// for being too sensitive -- which it does only for a credential the owner
// deliberately narrowed, and never for the default credential, whose ceiling is
// `restricted` and which therefore sees everything.
//
// Enforcement lives here and not in the MCP tool layer. A tool is one caller of
// a read function; a read function is where every caller arrives. Putting the
// ceiling in `server.ts` would mean the next tool, the next admin route and the
// next background job each had to remember it.

import type { ClientBase } from "pg";

/** Closed, ordered, low to high. */
export const SENSITIVITY_LEVELS = [
  "normal",
  "sensitive",
  "restricted",
] as const;

export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

/** A document nobody labelled. */
export const DEFAULT_SENSITIVITY: SensitivityLevel = "normal";

/**
 * What a credential gets when the owner does not narrow it: the top of the
 * scale, which means no withholding at all.
 *
 * This is the owner's decision as a constant. Every existing key and grant gets
 * it from migration 029's column default, and every new one gets it from the
 * forms unless the owner picks something lower.
 */
export const DEFAULT_MAX_SENSITIVITY: SensitivityLevel = "restricted";

const RANK: Record<SensitivityLevel, number> = {
  normal: 0,
  sensitive: 1,
  restricted: 2,
};

export function sensitivityRank(level: SensitivityLevel): number {
  return RANK[level];
}

/** Narrow unknown database or request text to a level, or `undefined`. */
export function asSensitivityLevel(
  value: unknown,
): SensitivityLevel | undefined {
  return typeof value === "string" &&
    (SENSITIVITY_LEVELS as readonly string[]).includes(value)
    ? (value as SensitivityLevel)
    : undefined;
}

/**
 * A level read off a row, defaulting rather than throwing.
 *
 * The database CHECK is the real guard; this keeps a legacy row or a NULL from
 * becoming `undefined` halfway through a comparison. Note the two different
 * fallbacks its callers pass: a document's own level falls back to `normal`
 * (nobody labelled it), and a credential's ceiling falls back to `restricted`
 * (nobody narrowed it). Getting those backwards would either hide documents
 * from the owner or ignore a narrowing he chose, so neither is defaulted here.
 */
export function readLevel(
  value: unknown,
  fallback: SensitivityLevel = DEFAULT_SENSITIVITY,
): SensitivityLevel {
  return asSensitivityLevel(value) ?? fallback;
}

/** The higher of two levels. An override raises and never lowers. */
export function maxSensitivity(
  left: SensitivityLevel,
  right: SensitivityLevel,
): SensitivityLevel {
  return RANK[left] >= RANK[right] ? left : right;
}

/** Whether a credential with this ceiling may read something at this level. */
export function withinCeiling(
  level: SensitivityLevel,
  ceiling: SensitivityLevel,
): boolean {
  return RANK[level] <= RANK[ceiling];
}

/**
 * What a narrowed read tells its caller.
 *
 * A count and nothing else: no ids, no titles, no kinds, no levels. The count
 * exists because silence is its own failure mode -- an assistant handed a
 * shortened list concludes the archive has nothing and tells the owner so,
 * which is a worse answer than "three documents are above this connection's
 * ceiling". A count says that without describing what was withheld.
 *
 * On the default ceiling this is always zero, and the read path that produces
 * it never runs.
 */
export type Withheld = { withheld: number };

// ---------------------------------------------------------------------------
// The store-layer reads
// ---------------------------------------------------------------------------

/**
 * The effective level of each of these documents.
 *
 * One query against `kith.document_sensitivity` (migration 029), which is the
 * only place the max-of-kind-item-root rule is written down. A document with no
 * row -- which cannot happen, the view LEFT JOINs over `documents` -- reads as
 * `normal` at the call site rather than throwing: failing a whole search over
 * one missing join would be worse than showing a receipt.
 */
export async function documentSensitivity(
  client: ClientBase,
  documentIds: readonly string[],
): Promise<Map<string, SensitivityLevel>> {
  const levels = new Map<string, SensitivityLevel>();
  if (documentIds.length === 0) return levels;
  const result = await client.query<{
    document_id: string;
    sensitivity: string;
  }>(
    `SELECT document_id, sensitivity
       FROM kith.document_sensitivity
      WHERE document_id = ANY($1::kith.kith_id[])`,
    [[...documentIds]],
  );
  for (const row of result.rows) {
    levels.set(row.document_id, readLevel(row.sensitivity));
  }
  return levels;
}

/**
 * Split rows into what this ceiling may see and a count of what it may not.
 *
 * Generic over the row so the document search, the inventory and the review
 * queue share one implementation: the shapes differ, the rule does not.
 *
 * The early return is the important line in this function. On the default
 * ceiling -- which is every credential the owner has not deliberately narrowed
 * -- this returns the rows untouched and issues no query at all. The feature is
 * literally absent from the owner's own read path rather than merely
 * permissive on it.
 */
export async function applyCeiling<T>(
  client: ClientBase,
  rows: readonly T[],
  documentIdOf: (row: T) => string | null | undefined,
  ceiling: SensitivityLevel,
): Promise<{ visible: T[]; withheld: number }> {
  if (rows.length === 0 || ceiling === "restricted") {
    return { visible: [...rows], withheld: 0 };
  }
  const ids = rows
    .map(documentIdOf)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const levels = await documentSensitivity(client, ids);
  const visible: T[] = [];
  let hidden = 0;
  for (const row of rows) {
    const id = documentIdOf(row);
    const level = id
      ? (levels.get(id) ?? DEFAULT_SENSITIVITY)
      : DEFAULT_SENSITIVITY;
    if (withinCeiling(level, ceiling)) visible.push(row);
    else hidden += 1;
  }
  return { visible, withheld: hidden };
}
