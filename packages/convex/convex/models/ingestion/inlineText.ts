import { MAX_CHUNKS, MAX_INLINE_TEXT_BYTES } from "./limits";

/** The fixed Phase 1 chunk boundary recorded in every processing fingerprint. */
export const MAX_INLINE_TEXT_CHUNK_UTF8_BYTES = 2_048;

export const INLINE_TEXT_CHUNKER_FINGERPRINT = "inline-text:utf8-2048-bytes:v1";

export type InlineTextChunk = {
  ordinal: number;
  /** UTF-16 offsets into the exact input text, safe for String#slice. */
  start: number;
  end: number;
  text: string;
};

export type InlineTextPlan = {
  text: string;
  chunks: InlineTextChunk[];
  expectedPageCount: 1;
  expectedEvidenceSpanCount: number;
  expectedDocumentCount: 1;
  expectedChunkCount: number;
  expectedEventCount: 0;
  expectedObservationCount: 0;
  chunkerFingerprint: typeof INLINE_TEXT_CHUNKER_FINGERPRINT;
};

function assertWellFormedUtf16(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Inline text contains an unpaired high surrogate");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("Inline text contains an unpaired low surrogate");
    }
  }
}

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Plans the exact Phase 1 representation of a validated inline-text source.
 * It deliberately walks valid UTF-16 itself so malformed strings cannot be
 * silently replaced with U+FFFD by UTF-8 encoders.
 */
export function planInlineText(text: string): InlineTextPlan {
  assertWellFormedUtf16(text);
  if (text.trim().length === 0) {
    throw new Error("Inline text must not be empty or whitespace-only");
  }

  const chunks: InlineTextChunk[] = [];
  let byteLength = 0;
  let chunkStart = 0;
  let chunkByteLength = 0;

  for (let index = 0; index < text.length;) {
    const firstUnit = text.charCodeAt(index);
    const isSurrogatePair = firstUnit >= 0xd800 && firstUnit <= 0xdbff;
    const codePoint = isSurrogatePair
      ? ((firstUnit - 0xd800) << 10) +
        (text.charCodeAt(index + 1) - 0xdc00) +
        0x10000
      : firstUnit;
    const unitLength = isSurrogatePair ? 2 : 1;
    const codePointBytes = utf8BytesForCodePoint(codePoint);

    if (
      chunkByteLength > 0 &&
      chunkByteLength + codePointBytes > MAX_INLINE_TEXT_CHUNK_UTF8_BYTES
    ) {
      chunks.push({
        ordinal: chunks.length,
        start: chunkStart,
        end: index,
        text: text.slice(chunkStart, index),
      });
      chunkStart = index;
      chunkByteLength = 0;
    }

    chunkByteLength += codePointBytes;
    byteLength += codePointBytes;
    index += unitLength;
  }

  if (byteLength > MAX_INLINE_TEXT_BYTES) {
    throw new Error(
      `Inline text exceeds the supported ${MAX_INLINE_TEXT_BYTES}-byte limit`,
    );
  }

  chunks.push({
    ordinal: chunks.length,
    start: chunkStart,
    end: text.length,
    text: text.slice(chunkStart),
  });
  if (chunks.length > MAX_CHUNKS) {
    throw new Error(
      `Inline text exceeds the supported ${MAX_CHUNKS} chunk limit`,
    );
  }

  return {
    text,
    chunks,
    expectedPageCount: 1,
    expectedEvidenceSpanCount: chunks.length,
    expectedDocumentCount: 1,
    expectedChunkCount: chunks.length,
    expectedEventCount: 0,
    expectedObservationCount: 0,
    chunkerFingerprint: INLINE_TEXT_CHUNKER_FINGERPRINT,
  };
}
