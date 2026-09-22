// Splits page text into chunk ranges, reusing the same policy as the
// "parsed staging path"'s chunker (`pageChunkRanges` / `pageChunksAndEvidence`
// in packages/pipeline/src/parsedBundleMapping.ts, CHUNK_TARGET_BYTES = 8192):
// walk the text one Unicode scalar at a time, accumulate each scalar's UTF-8
// byte length, and close a range at the scalar boundary before a chunk would
// exceed the target. One evidence span per chunk, page-local offsets, no
// overlap, no cross-page merging.
//
// That function is not exported by `packages/pipeline` (a frozen package this
// task must not modify, so its private helper cannot be imported), so this is
// a faithful, byte-for-byte reimplementation of the same algorithm rather than
// a new policy. See that file for the original.

export const CHUNK_TARGET_BYTES = 8_192;

export type ChunkRange = { start: number; end: number };

/** Non-overlapping, page-local UTF-8-byte-target ranges over `text`, split at
 * Unicode scalar (code point) boundaries. Empty text yields no ranges. */
export function pageChunkRanges(text: string): ChunkRange[] {
  const ranges: ChunkRange[] = [];
  let start = 0;
  let end = 0;
  let bytes = 0;
  for (const scalar of text) {
    const length = Buffer.byteLength(scalar, "utf8");
    if (bytes + length > CHUNK_TARGET_BYTES) {
      ranges.push({ start, end });
      start = end;
      bytes = 0;
    }
    end += scalar.length;
    bytes += length;
  }
  if (end > start) ranges.push({ start, end });
  return ranges;
}

/** Splits an array into batches of at most `size`, preserving order. Mirrors
 * the batching `inlineWork.ts` applies before `stageEvidenceSpans`/
 * `stageChunks`, whose own per-call row bound is `MAX_STAGING_ROWS`. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Splits `items` into batches of at most `maxRows` items whose combined
 * `textOf` UTF-8 byte length never exceeds `maxBytes`, preserving order.
 *
 * `stagePages` and `stageChunks` (`provenance/model.ts`) each sum every
 * row's own text in the batch and reject the whole call past
 * `MAX_STAGING_TEXT_UTF8_BYTES` (128 KiB) -- independent of, and tighter
 * than, `MAX_STAGING_ROWS` once rows carry real text: 25 chunks at this
 * package's own 8 KiB chunk target is up to 200 KiB, well over that per-call
 * limit, so row-count batching alone (`batches` above, still correct for
 * evidence spans, which carry no text) is not enough for pages or chunks.
 * A single item whose own text already exceeds `maxBytes` still gets its own
 * one-item batch, unbatchable smaller; `stagePages`/`stageChunks` reject
 * that call on the resource limit, which is the correct, existing error for
 * that case, not a change this function should hide.
 */
export function batchesByRowsAndBytes<T>(
  items: readonly T[],
  maxRows: number,
  maxBytes: number,
  textOf: (item: T) => string,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(textOf(item), "utf8");
    if (current.length > 0 && (current.length >= maxRows || currentBytes + itemBytes > maxBytes)) {
      out.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) out.push(current);
  return out;
}
