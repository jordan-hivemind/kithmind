// The inline-UTF-8 lane's fixed identity: its fingerprints, its chunk boundary
// and its plan.
//
// Ported from `models/ingestion/inlineText.ts`, `inlineInput.ts` and `hash.ts`,
// all three of which are pure and platform-independent already. The values are
// literals rather than derived, and they are the *same* literals, because every
// one of them is written into `processing_generations.processing_fingerprint` and
// into `worker_discovery_work.chunker_fingerprint`, and migrated rows carry the
// Convex strings verbatim. A single changed character here would make every
// migrated generation's fingerprint unreproducible, so `test/workerInline.test.mjs`
// asserts the literals rather than trusting the copy.
//
// `planInlineText` walks UTF-16 itself rather than encoding to UTF-8 and slicing.
// That is not an optimisation: a lone surrogate passed to `TextEncoder` becomes
// U+FFFD silently, which would change the text a worker sent into text the server
// stored, and the whole point of `content_hash_authority = server_verified_utf8`
// is that it did not.

/** The fixed Phase 1 chunk boundary recorded in every processing fingerprint. */
export const MAX_INLINE_TEXT_CHUNK_UTF8_BYTES = 2_048;
export const MAX_INLINE_TEXT_BYTES = 65_536;
export const MAX_INLINE_CHUNKS = 128;

export const INLINE_TEXT_CHUNKER_FINGERPRINT = "inline-text:utf8-2048-bytes:v1";
export const INLINE_EXTRACTION_FINGERPRINT = "inline-text:exact:v1";
export const INLINE_EXTRACTOR_FINGERPRINT = "none:inline-text:v1";
export const INLINE_RECORD_SCHEMA_FINGERPRINT = "generic-document:v1";
export const INLINE_NORMALIZATION_FINGERPRINT = "none:exact:v1";

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

/** Plans the exact Phase 1 representation of a validated inline-text source. */
export function planInlineText(text: string): InlineTextPlan {
  assertWellFormedUtf16(text);
  if (text.trim().length === 0) {
    throw new Error("Inline text must not be empty or whitespace-only");
  }

  const chunks: InlineTextChunk[] = [];
  let byteLength = 0;
  let chunkStart = 0;
  let chunkByteLength = 0;

  for (let index = 0; index < text.length; ) {
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
  if (chunks.length > MAX_INLINE_CHUNKS) {
    throw new Error(
      `Inline text exceeds the supported ${MAX_INLINE_CHUNKS} chunk limit`,
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

const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type ProcessingConfiguration = {
  extractionFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string;
};

/**
 * The generation's identity. Position in the array is the contract, so a field
 * may never be reordered or omitted: an existing generation is found by this
 * digest, and a changed one silently re-admits work that is already done.
 */
export async function digestProcessingConfiguration(
  configuration: ProcessingConfiguration,
): Promise<string> {
  return await sha256Hex(
    JSON.stringify([
      "processing-configuration-v1",
      configuration.extractionFingerprint,
      configuration.extractorFingerprint,
      configuration.recordSchemaFingerprint,
      configuration.normalizationFingerprint,
      configuration.chunkerFingerprint,
      configuration.correctionRevision,
    ]),
  );
}

/**
 * The admission receipt's digest. Same fixed-position array, same `v1`/`v2`
 * split: "zero typed records preserve receipts created before typed ingestion
 * existed", so a pre-typed receipt still replays rather than conflicting.
 */
export async function digestDecodedAdmissionEnvelope(envelope: {
  sourceAccountId: string;
  expectedDesiredProcessingEpoch: number;
  externalId: string;
  title?: string;
  docType?: string;
  uri?: string;
  capturedAt: number;
  mediaType: string;
  inlineText: string;
  extractionFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string;
  expectedPageCount: number;
  expectedEvidenceSpanCount: number;
  expectedDocumentCount: number;
  expectedChunkCount: number;
  expectedEventCount?: number;
  expectedObservationCount?: number;
}): Promise<string> {
  const typed =
    (envelope.expectedEventCount ?? 0) !== 0 ||
    (envelope.expectedObservationCount ?? 0) !== 0;
  return await sha256Hex(
    JSON.stringify([
      typed ? "decoded-ingest-admission-v2" : "decoded-ingest-admission-v1",
      envelope.sourceAccountId,
      envelope.expectedDesiredProcessingEpoch,
      envelope.externalId,
      envelope.title ?? null,
      envelope.docType ?? null,
      envelope.uri ?? null,
      envelope.capturedAt,
      envelope.mediaType,
      envelope.inlineText,
      envelope.extractionFingerprint,
      envelope.extractorFingerprint,
      envelope.recordSchemaFingerprint,
      envelope.normalizationFingerprint,
      envelope.chunkerFingerprint,
      envelope.correctionRevision,
      envelope.expectedPageCount,
      envelope.expectedEvidenceSpanCount,
      envelope.expectedDocumentCount,
      envelope.expectedChunkCount,
      ...(typed
        ? [
            envelope.expectedEventCount ?? 0,
            envelope.expectedObservationCount ?? 0,
          ]
        : []),
    ]),
  );
}
