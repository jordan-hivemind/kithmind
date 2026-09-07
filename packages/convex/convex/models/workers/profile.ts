import {
  INLINE_EXTRACTION_FINGERPRINT,
  INLINE_EXTRACTOR_FINGERPRINT,
  INLINE_NORMALIZATION_FINGERPRINT,
  INLINE_RECORD_SCHEMA_FINGERPRINT,
} from "../ingestion/inlineInput";
import { INLINE_TEXT_CHUNKER_FINGERPRINT } from "../ingestion/inlineText";

export const FS_TEXT_PROFILE = {
  profileId: "fs-text:v1",
  mediaType: "text/plain;charset=utf-8",
  extractionFingerprint: INLINE_EXTRACTION_FINGERPRINT,
  extractorFingerprint: INLINE_EXTRACTOR_FINGERPRINT,
  recordSchemaFingerprint: INLINE_RECORD_SCHEMA_FINGERPRINT,
  normalizationFingerprint: INLINE_NORMALIZATION_FINGERPRINT,
  chunkerFingerprint: INLINE_TEXT_CHUNKER_FINGERPRINT,
} as const;
