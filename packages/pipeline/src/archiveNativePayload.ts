import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const CREATED_AT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BLOCK_BYTES = 512;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const REGULAR_FILE = 0x30;

export type NativeDatabasePayloadManifest = Readonly<{
  kind: "native_convex_snapshot_v1";
  deployment: string;
  createdAt: string;
  includeFileStorage: true;
  byteLength: number;
  sha256: string;
  sourceCommit: string;
}>;

export type DecodeNativeDatabasePayloadInput = Readonly<{
  payload: Buffer;
  expectedPayloadSha256: string;
  expectedNativeZipSha256: string;
}>;

export type DecodedNativeDatabasePayload = Readonly<{
  nativeZip: Buffer;
  manifest: NativeDatabasePayloadManifest;
}>;

export class ArchiveNativePayloadError extends Error {
  constructor(
    readonly code: "invalid_input" | "digest_mismatch" | "invalid_payload",
  ) {
    super(`Archive native payload failed: ${code}`);
    this.name = "ArchiveNativePayloadError";
  }
}

function fail(code: ArchiveNativePayloadError["code"]): never {
  throw new ArchiveNativePayloadError(code);
}

function exactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    keys.some(
      (key) =>
        key === "__proto__" || key === "prototype" || key === "constructor",
    )
  ) {
    fail("invalid_payload");
  }
}

function isZero(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0);
}

function octal(bytes: Buffer, allowEmpty = false): number {
  if (bytes.some((byte) => byte > 0x7f || (byte & 0x80) !== 0)) {
    fail("invalid_payload");
  }
  const nul = bytes.indexOf(0);
  const valueBytes = nul < 0 ? bytes : bytes.subarray(0, nul);
  const remainder = nul < 0 ? Buffer.alloc(0) : bytes.subarray(nul + 1);
  if (remainder.some((byte) => byte !== 0 && byte !== 0x20)) {
    fail("invalid_payload");
  }
  const value = valueBytes.toString("ascii").trim();
  if (!value) {
    if (allowEmpty && isZero(bytes)) return 0;
    fail("invalid_payload");
  }
  if (!/^[0-7]+$/.test(value)) fail("invalid_payload");
  const parsed = BigInt(`0o${value}`);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail("invalid_payload");
  return Number(parsed);
}

function cString(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  if (nul < 0 || !isZero(bytes.subarray(nul + 1))) fail("invalid_payload");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, nul),
    );
  } catch {
    fail("invalid_payload");
  }
}

function checksum(header: Buffer): number {
  let total = 0;
  for (let index = 0; index < header.length; index += 1) {
    total += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return total;
}

function regularMember(
  header: Buffer,
  payload: Buffer,
  offset: number,
): { name: "native.zip" | "manifest.json"; bytes: Buffer; next: number } {
  if (
    header.length !== BLOCK_BYTES ||
    cString(header.subarray(345, 500)) !== "" ||
    cString(header.subarray(157, 257)) !== "" ||
    header.subarray(257, 263).compare(Buffer.from("ustar\0", "ascii")) !== 0 ||
    header.subarray(263, 265).compare(Buffer.from("00", "ascii")) !== 0 ||
    header[156] !== REGULAR_FILE ||
    octal(header.subarray(100, 108)) !== 0o600 ||
    octal(header.subarray(329, 337), true) !== 0 ||
    octal(header.subarray(337, 345), true) !== 0 ||
    octal(header.subarray(148, 156)) !== checksum(header)
  ) {
    fail("invalid_payload");
  }
  const name = cString(header.subarray(0, 100));
  if (name !== "native.zip" && name !== "manifest.json") {
    fail("invalid_payload");
  }
  const size = octal(header.subarray(124, 136));
  const maximum =
    name === "native.zip" ? MAX_PAYLOAD_BYTES : MAX_MANIFEST_BYTES;
  if (size < 1 || size > maximum) fail("invalid_payload");
  const dataEnd = offset + BLOCK_BYTES + size;
  const next = Math.ceil(dataEnd / BLOCK_BYTES) * BLOCK_BYTES;
  if (dataEnd > payload.length || next > payload.length) {
    fail("invalid_payload");
  }
  if (!isZero(payload.subarray(dataEnd, next))) fail("invalid_payload");
  return {
    name,
    bytes: payload.subarray(offset + BLOCK_BYTES, dataEnd),
    next,
  };
}

function tarMembers(payload: Buffer): Map<string, Buffer> {
  if (
    payload.length < 4 * BLOCK_BYTES ||
    payload.length > MAX_PAYLOAD_BYTES ||
    payload.length % BLOCK_BYTES !== 0
  ) {
    fail("invalid_input");
  }
  const members = new Map<string, Buffer>();
  let offset = 0;
  let ended = false;
  while (offset < payload.length) {
    if (offset + BLOCK_BYTES > payload.length) fail("invalid_payload");
    const header = payload.subarray(offset, offset + BLOCK_BYTES);
    if (isZero(header)) {
      const secondEnd = offset + 2 * BLOCK_BYTES;
      if (
        secondEnd > payload.length ||
        !isZero(payload.subarray(offset + BLOCK_BYTES, secondEnd)) ||
        !isZero(payload.subarray(secondEnd))
      ) {
        fail("invalid_payload");
      }
      ended = true;
      break;
    }
    const member = regularMember(header, payload, offset);
    if (members.has(member.name) || members.size >= 2) {
      fail("invalid_payload");
    }
    members.set(member.name, member.bytes);
    offset = member.next;
  }
  if (
    !ended ||
    members.size !== 2 ||
    !members.has("native.zip") ||
    !members.has("manifest.json")
  ) {
    fail("invalid_payload");
  }
  return members;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    fail("invalid_payload");
  }
  return value;
}

function manifest(bytes: Buffer): NativeDatabasePayloadManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid_payload");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_payload");
  }
  exactKeys(value, [
    "kind",
    "deployment",
    "createdAt",
    "includeFileStorage",
    "byteLength",
    "sha256",
    "sourceCommit",
  ]);
  const row = value as Record<string, unknown>;
  const deployment = boundedText(row.deployment, 256);
  const createdAt = boundedText(row.createdAt, 64);
  if (
    row.kind !== "native_convex_snapshot_v1" ||
    row.includeFileStorage !== true ||
    !CREATED_AT.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !Number.isSafeInteger(row.byteLength) ||
    (row.byteLength as number) < 1 ||
    (row.byteLength as number) > MAX_PAYLOAD_BYTES ||
    typeof row.sha256 !== "string" ||
    !SHA256.test(row.sha256) ||
    typeof row.sourceCommit !== "string" ||
    !GIT_COMMIT.test(row.sourceCommit)
  ) {
    fail("invalid_payload");
  }
  return {
    kind: "native_convex_snapshot_v1",
    deployment,
    createdAt,
    includeFileStorage: true,
    byteLength: row.byteLength as number,
    sha256: row.sha256,
    sourceCommit: row.sourceCommit,
  };
}

export function decodeNativeDatabasePayload(
  input: DecodeNativeDatabasePayloadInput,
): DecodedNativeDatabasePayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("invalid_input");
  }
  const keys = Object.keys(input);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(input, "payload") ||
    !Object.hasOwn(input, "expectedPayloadSha256") ||
    !Object.hasOwn(input, "expectedNativeZipSha256") ||
    !Buffer.isBuffer(input.payload) ||
    input.payload.length < 1 ||
    input.payload.length > MAX_PAYLOAD_BYTES ||
    !SHA256.test(input.expectedPayloadSha256) ||
    !SHA256.test(input.expectedNativeZipSha256)
  ) {
    fail("invalid_input");
  }
  if (
    createHash("sha256").update(input.payload).digest("hex") !==
    input.expectedPayloadSha256
  ) {
    fail("digest_mismatch");
  }
  const members = tarMembers(input.payload);
  const nativeZip = members.get("native.zip")!;
  const metadata = manifest(members.get("manifest.json")!);
  const nativeZipSha256 = createHash("sha256").update(nativeZip).digest("hex");
  if (
    nativeZip.length !== metadata.byteLength ||
    nativeZipSha256 !== metadata.sha256 ||
    nativeZipSha256 !== input.expectedNativeZipSha256
  ) {
    fail("digest_mismatch");
  }
  return { nativeZip: Buffer.from(nativeZip), manifest: metadata };
}
