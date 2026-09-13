// The five digests a scan entry is identified by.
//
// Ported verbatim from `model.ts`'s `entryDigests`, including every domain label
// and every array position, because these are not internal hashes. Three of them
// are compared against values stored on `source_items` by an earlier pass:
//
//   * `inventoryMetadataDigest` decides whether the observation epoch advances,
//     which is what makes a file "changed" and re-enumerated.
//   * `processingIdentityDigest` decides whether the processing epoch advances,
//     which is what makes a file re-parsed rather than left alone.
//   * `identityKeyHash` is the per-scan uniqueness key, so a changed digest turns
//     two entries into a duplicate or stops finding one.
//
// A migrated `source_items` row carries the Convex digests. A single reordered
// array element would therefore make every existing file look changed on the
// first pass after cutover, re-parsing the whole corpus. That is why the domain
// strings keep their `:v1` suffixes and why the ready/binary/gap branches keep
// their exact field order rather than being factored into something tidier.

import type { FsDiscoveryEntry } from "@repo/worker-protocol/request";

import { sha256Utf8 } from "../provenance/sql.js";
import { digest } from "./db.js";
import { FS_TEXT_PROFILE } from "./profile.js";

export type FsReadyDiscoveryEntry = Omit<FsDiscoveryEntry, "content"> & {
  content: Exclude<FsDiscoveryEntry["content"], { status: "gap" }>;
};

export function isReadyEntry(
  entry: FsDiscoveryEntry,
): entry is FsReadyDiscoveryEntry {
  return entry.content.status !== "gap";
}

export type ProcessingProfile = {
  representation: "inline_utf8_v1" | "archived_binary_v1";
  mediaType: string;
  profileId: string;
  parserFingerprint: string | undefined;
  extractionConfigurationFingerprint: string | undefined;
  extractionFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string | undefined;
};

/** The processing identity a ready entry declares, by representation. */
export function processingProfile(
  entry: FsReadyDiscoveryEntry,
): ProcessingProfile {
  return entry.content.status === "ready"
    ? {
        representation: "inline_utf8_v1",
        mediaType: FS_TEXT_PROFILE.mediaType,
        profileId: FS_TEXT_PROFILE.profileId,
        parserFingerprint: undefined,
        extractionConfigurationFingerprint: undefined,
        extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
        extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
        recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
        normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
        chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
        correctionRevision: undefined,
      }
    : {
        representation: "archived_binary_v1",
        mediaType: entry.content.mediaType,
        profileId: entry.content.parserProfileId,
        parserFingerprint: entry.content.parserFingerprint,
        extractionConfigurationFingerprint:
          entry.content.extractionConfigurationFingerprint,
        extractionFingerprint: "artifact-bound-extraction:v1",
        extractorFingerprint: entry.content.extractorFingerprint,
        recordSchemaFingerprint: entry.content.recordSchemaFingerprint,
        normalizationFingerprint: entry.content.normalizationFingerprint,
        chunkerFingerprint: entry.content.chunkerFingerprint,
        correctionRevision: entry.content.correctionRevision,
      };
}

export type EntryDigests = {
  externalIdHash?: string;
  uriDigest: string;
  identityKeyHash: string;
  inventoryMetadataDigest: string;
  processingIdentityDigest?: string;
};

export async function uriDigest(
  sourceAccountId: string,
  uri: string,
): Promise<string> {
  return digest("worker-fs-uri:v1", [sourceAccountId, uri]);
}

export async function entryDigests(
  sourceAccountId: string,
  entry: FsDiscoveryEntry,
): Promise<EntryDigests> {
  const extHash =
    entry.externalId === undefined
      ? undefined
      : await sha256Utf8(entry.externalId);
  const pathDigest = await uriDigest(sourceAccountId, entry.uri);
  const processingIdentityDigest =
    entry.content.status === "ready"
      ? await digest("worker-fs-processing-identity:v1", [
          entry.content.sha256,
          FS_TEXT_PROFILE.mediaType,
          FS_TEXT_PROFILE.profileId,
          FS_TEXT_PROFILE.extractionFingerprint,
          FS_TEXT_PROFILE.extractorFingerprint,
          FS_TEXT_PROFILE.recordSchemaFingerprint,
          FS_TEXT_PROFILE.normalizationFingerprint,
          FS_TEXT_PROFILE.chunkerFingerprint,
        ])
      : entry.content.status === "ready_binary_v1"
        ? await digest("worker-fs-binary-processing-identity:v1", [
            entry.content.sha256,
            entry.content.mediaType,
            entry.content.parserProfileId,
            entry.content.parserFingerprint,
            entry.content.extractionConfigurationFingerprint,
            entry.content.extractorFingerprint,
            entry.content.recordSchemaFingerprint,
            entry.content.normalizationFingerprint,
            entry.content.chunkerFingerprint,
            entry.content.correctionRevision,
          ])
        : undefined;
  const inventoryMetadataDigest =
    entry.content.status === "ready_binary_v1"
      ? await digest("worker-fs-binary-inventory-metadata:v1", [
          extHash ?? null,
          pathDigest,
          entry.title ?? null,
          entry.docType ?? null,
          entry.sourceModifiedAt,
          entry.content.status,
          entry.content.sha256,
          entry.content.byteLength,
          entry.content.parserProfileId,
        ])
      : await digest("worker-fs-inventory-metadata:v1", [
          extHash ?? null,
          pathDigest,
          entry.title ?? null,
          entry.docType ?? null,
          entry.sourceModifiedAt,
          entry.content.status,
          entry.content.status === "ready" ? entry.content.sha256 : null,
          entry.content.status === "ready" ? entry.content.byteLength : null,
          entry.content.status === "gap" ? entry.content.code : null,
          FS_TEXT_PROFILE.profileId,
        ]);
  return {
    ...(extHash === undefined ? {} : { externalIdHash: extHash }),
    uriDigest: pathDigest,
    identityKeyHash: extHash ?? pathDigest,
    inventoryMetadataDigest,
    ...(processingIdentityDigest === undefined
      ? {}
      : { processingIdentityDigest }),
  };
}
