// Synthetic-fixture unit tests for the page chunker: non-overlapping ranges
// at an 8 KiB UTF-8-byte target, split at Unicode scalar boundaries, plus the
// batching helper the write path uses before every staging call.

import assert from "node:assert/strict";
import test from "node:test";

import { batches, batchesByRowsAndBytes, CHUNK_TARGET_BYTES, pageChunkRanges } from "../dist/chunker.js";

test("pageChunkRanges returns no ranges for empty text", () => {
  assert.deepEqual(pageChunkRanges(""), []);
});

test("pageChunkRanges returns one range for text under the target", () => {
  const text = "Statement for account ending 1234.";
  const ranges = pageChunkRanges(text);
  assert.deepEqual(ranges, [{ start: 0, end: text.length }]);
  assert.equal(text.slice(ranges[0].start, ranges[0].end), text);
});

test("pageChunkRanges splits text larger than the byte target, covering it exactly", () => {
  // Each line is 40 ASCII bytes; ~205 lines comfortably exceeds two 8 KiB
  // chunks without depending on an exact byte count.
  const line = "0123456789".repeat(4) + "\n";
  const text = line.repeat(300);
  const ranges = pageChunkRanges(text);
  assert.ok(ranges.length > 1, "expected more than one chunk");

  // Ranges are contiguous and cover the whole string with no gap or overlap.
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges.at(-1).end, text.length);
  for (let i = 1; i < ranges.length; i += 1) {
    assert.equal(ranges[i].start, ranges[i - 1].end);
  }

  // No range (but the last) exceeds the byte target.
  for (const range of ranges.slice(0, -1)) {
    const bytes = Buffer.byteLength(text.slice(range.start, range.end), "utf8");
    assert.ok(bytes <= CHUNK_TARGET_BYTES, `chunk of ${bytes} bytes exceeds the target`);
  }
});

test("pageChunkRanges never splits inside a multi-byte Unicode scalar", () => {
  // An emoji (4 UTF-8 bytes, one UTF-16 surrogate pair) repeated until it
  // crosses the chunk target, so a byte-oriented splitter would be tempted
  // to cut mid-scalar.
  const text = "🙂".repeat(3000);
  const ranges = pageChunkRanges(text);
  assert.ok(ranges.length > 1);
  for (const range of ranges) {
    const slice = text.slice(range.start, range.end);
    // A slice built only of whole scalars round-trips through Array.from
    // (which iterates by code point) to the same length it started with.
    assert.equal(Array.from(slice).join(""), slice);
    assert.equal(slice.length % 2, 0, "range boundary split a surrogate pair");
  }
});

test("batches splits into groups of at most `size`, preserving order", () => {
  const items = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(batches(items, 3), [[0, 1, 2], [3, 4, 5], [6]]);
  assert.deepEqual(batches([], 3), []);
  assert.deepEqual(batches([1], 25), [[1]]);
});

test("batchesByRowsAndBytes splits on whichever bound (rows or bytes) is hit first", () => {
  const items = ["aa", "bb", "cc", "dd", "ee"]; // 2 bytes each
  // Row bound binds first: 5 bytes/row well under a 100-byte budget.
  assert.deepEqual(
    batchesByRowsAndBytes(items, 2, 100, (s) => s),
    [["aa", "bb"], ["cc", "dd"], ["ee"]],
  );
  // Byte bound binds first: a 5-byte budget admits at most 2 two-byte rows.
  assert.deepEqual(
    batchesByRowsAndBytes(items, 25, 5, (s) => s),
    [["aa", "bb"], ["cc", "dd"], ["ee"]],
  );
  assert.deepEqual(batchesByRowsAndBytes([], 25, 100, (s) => s), []);
});

test("batchesByRowsAndBytes never splits mid-item, even one whose own text exceeds the byte budget", () => {
  const items = ["short", "x".repeat(50)];
  const result = batchesByRowsAndBytes(items, 25, 10, (s) => s);
  // The oversized item still gets exactly one batch to itself, not dropped
  // and not split; the caller's own row-limit check is what refuses it.
  assert.deepEqual(result, [["short"], ["x".repeat(50)]]);
});
