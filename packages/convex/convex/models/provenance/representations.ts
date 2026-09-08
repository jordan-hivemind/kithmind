export const MAX_ARCHIVED_BINARY_BYTES = 16 * 1_024 * 1_024;
export const MAX_PARSER_ARTIFACT_BYTES = 64 * 1_024 * 1_024;
export const MAX_PARSED_TEXT_UTF8_BYTES = 1_024 * 1_024;
export const MAX_PARSED_TEXT_PAGES = 64;
export const MAX_LEGACY_INLINE_UTF8_BYTES = 65_536;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MEDIA_TYPE_CHARS = 255;
const MAX_FINGERPRINT_UTF8_BYTES = 1_024;
const MAX_LEGACY_ARCHIVE_REF_UTF8_BYTES = 8_192;

type SourceRevisionShape = {
  representation?: "inline_utf8_v1" | "archived_binary_v1";
  contentHashAuthority?: "server_verified_utf8" | "worker_asserted";
  contentHash: string;
  byteLength: number;
  mediaType: string;
  inlineText?: string;
  archiveRef?: string;
};

type SourceTextVersionShape = {
  representation?: "inline_text_v1" | "parsed_pages_v1";
  extractionFingerprint: string;
  text?: string;
  textHash: string;
  textHashAuthority?: "server_verified_retained_text";
  byteLength: number;
  utf16Length?: number;
  pageCount?: number;
  mappingManifestHash?: string;
  parserArtifactId?: string;
  evidenceSealed: boolean;
};

export type ParsedSourceRevisionRepresentation =
  | {
      kind: "inline_utf8_v1";
      text: string;
      hashAuthority: "server_verified_utf8";
      implicitLegacy: boolean;
    }
  | {
      kind: "archived_binary_v1";
      hashAuthority: "worker_asserted";
    };

export type ParsedSourceTextRepresentation =
  | {
      kind: "inline_text_v1";
      text: string;
      hashAuthority: "server_verified_retained_text";
      implicitLegacy: boolean;
    }
  | {
      kind: "parsed_pages_v1";
      parserArtifactId: string;
      utf16Length: number;
      pageCount: number;
      mappingManifestHash: string;
      hashAuthority?: "server_verified_retained_text";
      sealed: boolean;
    };

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function requireSafeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be a safe integer from ${minimum} to ${maximum}`,
    );
  }
}

function requireBoundedString(
  value: string,
  label: string,
  maximum: number,
): void {
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} UTF-16 code units`);
  }
}

function requireBoundedUtf8(
  value: string,
  label: string,
  maximum: number,
): void {
  const length = utf8Length(value);
  if (length === 0 || length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} UTF-8 bytes`);
  }
}

function requireNoParsedTextFields(value: SourceTextVersionShape): void {
  if (
    value.parserArtifactId !== undefined ||
    value.utf16Length !== undefined ||
    value.pageCount !== undefined ||
    value.mappingManifestHash !== undefined
  ) {
    throw new Error("Inline source text version has parsed-only fields");
  }
}

function requireLegacyInlineBounds(
  text: string,
  storedByteLength: number,
  label: string,
): void {
  if (
    storedByteLength > MAX_LEGACY_INLINE_UTF8_BYTES ||
    utf8Length(text) > MAX_LEGACY_INLINE_UTF8_BYTES
  ) {
    throw new Error(
      `${label} exceeds ${MAX_LEGACY_INLINE_UTF8_BYTES} UTF-8 bytes`,
    );
  }
}

function requireLegacyArchiveRef(value: string | undefined): void {
  if (value !== undefined) {
    requireBoundedUtf8(
      value,
      "Legacy archive reference",
      MAX_LEGACY_ARCHIVE_REF_UTF8_BYTES,
    );
  }
}

export function parseSourceRevisionRepresentation(
  value: SourceRevisionShape,
): ParsedSourceRevisionRepresentation {
  requireSha256(value.contentHash, "Source revision content hash");
  requireSafeInteger(
    value.byteLength,
    "Source revision byte length",
    0,
    MAX_ARCHIVED_BINARY_BYTES,
  );
  requireBoundedString(
    value.mediaType,
    "Source revision media type",
    MAX_MEDIA_TYPE_CHARS,
  );

  if (value.representation === undefined) {
    if (
      typeof value.inlineText !== "string" ||
      value.contentHashAuthority !== undefined
    ) {
      throw new Error("Implicit legacy source revision fields are invalid");
    }
    requireLegacyInlineBounds(
      value.inlineText,
      value.byteLength,
      "Inline source revision",
    );
    requireLegacyArchiveRef(value.archiveRef);
    return {
      kind: "inline_utf8_v1",
      text: value.inlineText,
      hashAuthority: "server_verified_utf8",
      implicitLegacy: true,
    };
  }

  if (value.representation === "inline_utf8_v1") {
    if (
      typeof value.inlineText !== "string" ||
      value.contentHashAuthority !== "server_verified_utf8"
    ) {
      throw new Error("Explicit inline source revision fields are invalid");
    }
    requireLegacyInlineBounds(
      value.inlineText,
      value.byteLength,
      "Inline source revision",
    );
    requireLegacyArchiveRef(value.archiveRef);
    return {
      kind: "inline_utf8_v1",
      text: value.inlineText,
      hashAuthority: "server_verified_utf8",
      implicitLegacy: false,
    };
  }

  if (value.representation !== "archived_binary_v1") {
    throw new Error("Unknown source revision representation");
  }

  if (
    value.contentHashAuthority !== "worker_asserted" ||
    value.inlineText !== undefined ||
    value.archiveRef !== undefined ||
    value.mediaType !== "application/pdf"
  ) {
    throw new Error("Archived binary source revision fields are invalid");
  }
  requireSafeInteger(
    value.byteLength,
    "Archived binary byte length",
    1,
    MAX_ARCHIVED_BINARY_BYTES,
  );
  return {
    kind: "archived_binary_v1",
    hashAuthority: "worker_asserted",
  };
}

export function requireInlineSourceRevision(
  value: SourceRevisionShape,
): Extract<ParsedSourceRevisionRepresentation, { kind: "inline_utf8_v1" }> {
  const parsed = parseSourceRevisionRepresentation(value);
  if (parsed.kind !== "inline_utf8_v1") {
    throw new Error("Operation requires an inline UTF-8 source revision");
  }
  return parsed;
}

export function parseSourceTextRepresentation(
  value: SourceTextVersionShape,
): ParsedSourceTextRepresentation {
  requireBoundedUtf8(
    value.extractionFingerprint,
    "Extraction fingerprint",
    MAX_FINGERPRINT_UTF8_BYTES,
  );
  requireSha256(value.textHash, "Source text hash");
  requireSafeInteger(
    value.byteLength,
    "Source text byte length",
    0,
    MAX_PARSED_TEXT_UTF8_BYTES,
  );

  if (value.representation === undefined) {
    if (
      typeof value.text !== "string" ||
      value.textHashAuthority !== undefined
    ) {
      throw new Error("Implicit legacy source text fields are invalid");
    }
    requireNoParsedTextFields(value);
    requireLegacyInlineBounds(
      value.text,
      value.byteLength,
      "Inline source text version",
    );
    return {
      kind: "inline_text_v1",
      text: value.text,
      hashAuthority: "server_verified_retained_text",
      implicitLegacy: true,
    };
  }

  if (value.representation === "inline_text_v1") {
    if (
      typeof value.text !== "string" ||
      value.textHashAuthority !== "server_verified_retained_text"
    ) {
      throw new Error("Explicit inline source text fields are invalid");
    }
    requireNoParsedTextFields(value);
    requireLegacyInlineBounds(
      value.text,
      value.byteLength,
      "Inline source text version",
    );
    return {
      kind: "inline_text_v1",
      text: value.text,
      hashAuthority: "server_verified_retained_text",
      implicitLegacy: false,
    };
  }

  if (value.representation !== "parsed_pages_v1") {
    throw new Error("Unknown source text representation");
  }

  if (
    value.text !== undefined ||
    typeof value.parserArtifactId !== "string" ||
    value.parserArtifactId.length === 0 ||
    value.utf16Length === undefined ||
    value.pageCount === undefined ||
    value.mappingManifestHash === undefined
  ) {
    throw new Error("Parsed source text version fields are invalid");
  }
  if (
    (value.evidenceSealed &&
      value.textHashAuthority !== "server_verified_retained_text") ||
    (!value.evidenceSealed && value.textHashAuthority !== undefined)
  ) {
    throw new Error("Parsed source text verification state is invalid");
  }
  requireSafeInteger(
    value.byteLength,
    "Parsed source text byte length",
    1,
    MAX_PARSED_TEXT_UTF8_BYTES,
  );
  requireSafeInteger(
    value.utf16Length,
    "Parsed source text UTF-16 length",
    1,
    MAX_PARSED_TEXT_UTF8_BYTES,
  );
  requireSafeInteger(
    value.pageCount,
    "Parsed source text page count",
    1,
    MAX_PARSED_TEXT_PAGES,
  );
  requireSha256(value.mappingManifestHash, "Normalized mapping manifest hash");
  return {
    kind: "parsed_pages_v1",
    parserArtifactId: value.parserArtifactId,
    utf16Length: value.utf16Length,
    pageCount: value.pageCount,
    mappingManifestHash: value.mappingManifestHash,
    hashAuthority: value.textHashAuthority,
    sealed: value.evidenceSealed,
  };
}

export function requireInlineSourceTextVersion(
  value: SourceTextVersionShape,
): Extract<ParsedSourceTextRepresentation, { kind: "inline_text_v1" }> {
  const parsed = parseSourceTextRepresentation(value);
  if (parsed.kind !== "inline_text_v1") {
    throw new Error("Operation requires an inline source text version");
  }
  return parsed;
}
