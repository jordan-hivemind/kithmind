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
