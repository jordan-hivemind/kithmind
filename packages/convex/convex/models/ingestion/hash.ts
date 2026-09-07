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

export async function digestProcessingConfiguration(configuration: {
  extractionFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string;
}): Promise<string> {
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
 * Canonical digest for already-decoded MCP/action admission arguments.
 * The fixed-position array is versioned and preserves every JavaScript string
 * exactly; in particular it performs no Unicode or newline normalization.
 * This is intentionally not described as a digest of raw HTTP request bytes.
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
  // Zero typed records preserve receipts created before typed ingestion existed.
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
