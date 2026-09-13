import {
  isBinaryParserProfileId,
  type BinaryParserProfileId,
} from "@repo/worker-protocol";

import type { Doc } from "../../_generated/dataModel";
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

/**
 * P2-70i2: the binary classes this account is audited for. `binaryProfileIds`
 * is the closed set when present; an account that predates it keeps naming its
 * one audited class in `binaryProfileId`. A class the owner has not listed is
 * not admitted, because the audit that enables a class is per class: the
 * measured parser acceptance of a workbook says nothing about a PDF.
 */
export function accountBinaryClasses(
  account: Doc<"sourceAccounts">,
): readonly BinaryParserProfileId[] {
  if (account.binaryProfileIds !== undefined) return account.binaryProfileIds;
  return account.binaryProfileId ? [account.binaryProfileId] : [];
}

export function accountAdmitsBinaryClass(
  account: Doc<"sourceAccounts">,
  profileId: unknown,
): boolean {
  return (
    isBinaryParserProfileId(profileId) &&
    accountBinaryClasses(account).includes(profileId)
  );
}
