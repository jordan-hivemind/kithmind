import { describe, expect, test } from "vitest";

import {
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
} from "./representations";

const HASH = "a".repeat(64);

describe("provenance representation parsing", () => {
  test("preserves implicit legacy UTF-8 rows, including empty and non-ASCII text", () => {
    expect(
      parseSourceRevisionRepresentation({
        contentHash: HASH,
        byteLength: 0,
        mediaType: "text/plain; charset=utf-8",
        inlineText: "",
      }),
    ).toMatchObject({ kind: "inline_utf8_v1", implicitLegacy: true });
    expect(
      parseSourceTextRepresentation({
        extractionFingerprint: "legacy:é",
        text: "é😀",
        textHash: HASH,
        byteLength: 6,
        evidenceSealed: false,
      }),
    ).toMatchObject({
      kind: "inline_text_v1",
      text: "é😀",
      implicitLegacy: true,
    });
  });

  test("accepts only exact explicit revision branches", () => {
    expect(
      parseSourceRevisionRepresentation({
        representation: "archived_binary_v1",
        contentHashAuthority: "worker_asserted",
        contentHash: HASH,
        byteLength: 16 * 1_024 * 1_024,
        mediaType: "application/pdf",
      }),
    ).toEqual({
      kind: "archived_binary_v1",
      hashAuthority: "worker_asserted",
    });
    expect(() =>
      parseSourceRevisionRepresentation({
        representation: "future_binary_v2",
        contentHashAuthority: "worker_asserted",
        contentHash: HASH,
        byteLength: 100,
        mediaType: "application/pdf",
      } as never),
    ).toThrow("Unknown source revision representation");
    expect(() =>
      parseSourceRevisionRepresentation({
        representation: "archived_binary_v1",
        contentHashAuthority: "worker_asserted",
        contentHash: HASH,
        byteLength: 100,
        mediaType: "application/pdf",
        inlineText: "%PDF-as-text",
      }),
    ).toThrow("Archived binary source revision fields are invalid");
    expect(() =>
      parseSourceRevisionRepresentation({
        representation: "archived_binary_v1",
        contentHashAuthority: "worker_asserted",
        contentHash: HASH,
        byteLength: 16 * 1_024 * 1_024 + 1,
        mediaType: "application/pdf",
      }),
    ).toThrow("safe integer from 0 to 16777216");
  });

  test("keeps parsed text unverified until an exact seal authority is present", () => {
    const parsed = {
      representation: "parsed_pages_v1" as const,
      extractionFingerprint: "docling:locked",
      textHash: HASH,
      byteLength: 1_024 * 1_024,
      utf16Length: 1_024 * 1_024,
      pageCount: 2,
      mappingManifestHash: "b".repeat(64),
      parserArtifactId: "artifact-id",
    };
    expect(
      parseSourceTextRepresentation({ ...parsed, evidenceSealed: false }),
    ).toMatchObject({ kind: "parsed_pages_v1", sealed: false });
    expect(
      parseSourceTextRepresentation({
        ...parsed,
        evidenceSealed: true,
        textHashAuthority: "server_verified_retained_text",
      }),
    ).toMatchObject({
      kind: "parsed_pages_v1",
      sealed: true,
      hashAuthority: "server_verified_retained_text",
    });
    expect(() =>
      parseSourceTextRepresentation({
        ...parsed,
        representation: "future_pages_v2",
        evidenceSealed: false,
      } as never),
    ).toThrow("Unknown source text representation");
    expect(() =>
      parseSourceTextRepresentation({
        ...parsed,
        evidenceSealed: false,
        textHashAuthority: "server_verified_retained_text",
      }),
    ).toThrow("verification state is invalid");
    expect(() =>
      parseSourceTextRepresentation({
        ...parsed,
        byteLength: 1_024 * 1_024 + 1,
        evidenceSealed: false,
      }),
    ).toThrow("safe integer from 0 to 1048576");
  });
});
