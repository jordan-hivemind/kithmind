// The worker profile gate: which parser classes an account may admit.
//
// Ported from `models/workers/profile.ts` (PR194/P2-70i2). The rule it encodes is
// the reason it is a closed per-class set rather than a boolean: "the audit that
// enables a class is per class, because the measured parser acceptance of a
// workbook says nothing about a PDF". An account that predates `binaryProfileIds`
// still names its one audited class in `binaryProfileId`.
//
// Three fields have to agree before a binary entry is admitted, and the account
// row carries all three: the class list, the enablement timestamp and the audit
// digest. Any one missing means the owner has not actually enabled the class, and
// the answer is `source_unavailable` rather than a partial admission.

import { isBinaryParserProfileId, type BinaryParserProfileId } from "@repo/worker-protocol";

import {
  INLINE_EXTRACTION_FINGERPRINT,
  INLINE_EXTRACTOR_FINGERPRINT,
  INLINE_NORMALIZATION_FINGERPRINT,
  INLINE_RECORD_SCHEMA_FINGERPRINT,
  INLINE_TEXT_CHUNKER_FINGERPRINT,
} from "../ingestion/inline.js";
import type { SourceAccountRow } from "./rows.js";

/** The one non-binary profile the filesystem lane admits. */
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
 * The binary classes this account is audited for.
 *
 * `binary_profile_ids` is `jsonb`, so node-pg hands back the array itself. A
 * value that is not an array of known class ids contributes nothing rather than
 * throwing: a damaged column must narrow what is admitted, never widen it.
 */
export function accountBinaryClasses(
  account: Pick<SourceAccountRow, "binaryProfileIds" | "binaryProfileId">,
): readonly BinaryParserProfileId[] {
  if (account.binaryProfileIds !== null && account.binaryProfileIds !== undefined) {
    return Array.isArray(account.binaryProfileIds)
      ? account.binaryProfileIds.filter((value): value is BinaryParserProfileId =>
          isBinaryParserProfileId(value),
        )
      : [];
  }
  return isBinaryParserProfileId(account.binaryProfileId)
    ? [account.binaryProfileId]
    : [];
}

export function accountAdmitsBinaryClass(
  account: Pick<SourceAccountRow, "binaryProfileIds" | "binaryProfileId">,
  profileId: unknown,
): boolean {
  return (
    isBinaryParserProfileId(profileId) &&
    accountBinaryClasses(account).includes(profileId)
  );
}

/**
 * Whether the account's binary lane is actually enabled, independent of class.
 *
 * `binary_profile_enabled_at` is `timestamptz` here where Convex held epoch ms,
 * so the original's `Number.isSafeInteger(...) && >= 0` becomes "a present,
 * valid timestamp". The audit digest keeps its exact shape check: a 64-character
 * lowercase hex SHA-256 and nothing else, so a truncated or placeholder digest
 * does not pass for an audit.
 */
export function accountBinaryLaneEnabled(
  account: Pick<
    SourceAccountRow,
    "binaryProfileEnabledAt" | "binaryProfileAuditDigest"
  >,
): boolean {
  const enabledAt = account.binaryProfileEnabledAt;
  return (
    enabledAt instanceof Date &&
    !Number.isNaN(enabledAt.getTime()) &&
    typeof account.binaryProfileAuditDigest === "string" &&
    /^[0-9a-f]{64}$/.test(account.binaryProfileAuditDigest)
  );
}

/** The whole gate, both halves, for one class. */
export function accountAdmitsBinaryEntry(
  account: Pick<
    SourceAccountRow,
    | "binaryProfileIds"
    | "binaryProfileId"
    | "binaryProfileEnabledAt"
    | "binaryProfileAuditDigest"
  >,
  profileId: unknown,
): boolean {
  return (
    accountAdmitsBinaryClass(account, profileId) &&
    accountBinaryLaneEnabled(account)
  );
}
