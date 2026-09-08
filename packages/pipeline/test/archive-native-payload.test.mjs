import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ArchiveNativePayloadError,
  decodeNativeDatabasePayload,
} from "../dist/archiveNativePayload.js";

const BLOCK_BYTES = 512;
const RECORD_BYTES = 10_240;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeOctal(header, offset, length, value) {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function member(name, bytes, options = {}) {
  const header = Buffer.alloc(BLOCK_BYTES);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, options.mode ?? 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, options.size ?? bytes.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = (options.type ?? "0").charCodeAt(0);
  if (options.linkName) header.write(options.linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  if (options.prefix) header.write(options.prefix, 345, 155, "utf8");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  if (options.badChecksum) header[148] ^= 1;
  const padding = Buffer.alloc(
    Math.ceil(bytes.length / BLOCK_BYTES) * BLOCK_BYTES - bytes.length,
  );
  if (options.nonzeroPadding && padding.length) padding[0] = 1;
  return Buffer.concat([header, bytes, padding]);
}

function tar(members, options = {}) {
  const body = Buffer.concat([
    ...members,
    Buffer.alloc(options.singleEndBlock ? BLOCK_BYTES : 2 * BLOCK_BYTES),
  ]);
  if (options.singleEndBlock || options.noRecordPadding) return body;
  return Buffer.concat([
    body,
    Buffer.alloc(
      Math.ceil(body.length / RECORD_BYTES) * RECORD_BYTES - body.length,
    ),
  ]);
}

const nativeZip = Buffer.from(
  "PK\x03\x04synthetic native Convex ZIP",
  "binary",
);

function manifest(overrides = {}) {
  return {
    kind: "native_convex_snapshot_v1",
    deployment: "synthetic:test",
    createdAt: "2026-09-08T23:30:00.123456+00:00",
    includeFileStorage: true,
    byteLength: nativeZip.length,
    sha256: sha256(nativeZip),
    sourceCommit: "a".repeat(40),
    ...overrides,
  };
}

function payload(options = {}) {
  const metadata =
    options.manifestBytes ??
    Buffer.from(JSON.stringify(manifest(options.manifestOverrides)), "utf8");
  return tar(
    options.members ?? [
      member("native.zip", nativeZip, options.nativeOptions),
      member("manifest.json", metadata, options.manifestOptions),
    ],
    options.tarOptions,
  );
}

function decode(bytes, overrides = {}) {
  return decodeNativeDatabasePayload({
    payload: bytes,
    expectedPayloadSha256: sha256(bytes),
    expectedNativeZipSha256: sha256(nativeZip),
    ...overrides,
  });
}

function rejects(bytes, code = "invalid_payload", overrides = {}) {
  assert.throws(
    () => decode(bytes, overrides),
    (error) =>
      error instanceof ArchiveNativePayloadError && error.code === code,
  );
}

test("decodes the closed two-member native database payload in memory", () => {
  const bytes = payload();
  const originalPayload = Buffer.from(bytes);
  const result = decode(bytes);
  assert.deepEqual(result.nativeZip, nativeZip);
  assert.deepEqual(result.manifest, manifest());
  result.nativeZip[0] ^= 0xff;
  assert.deepEqual(
    bytes,
    originalPayload,
    "mutating the decoded ZIP must not mutate its source payload",
  );
});

test("rejects unsafe tar members, headers, padding, and truncation", () => {
  const metadata = Buffer.from(JSON.stringify(manifest()), "utf8");
  const invalid = [
    tar([
      member("native.zip", nativeZip),
      member("native.zip", nativeZip),
      member("manifest.json", metadata),
    ]),
    payload({ nativeOptions: { type: "2", linkName: "target" } }),
    payload({ nativeOptions: { type: "x" } }),
    payload({ nativeOptions: { type: "S" } }),
    tar([
      member("../native.zip", nativeZip),
      member("manifest.json", metadata),
    ]),
    payload({ nativeOptions: { prefix: "nested" } }),
    payload({ nativeOptions: { mode: 0o644 } }),
    payload({ nativeOptions: { badChecksum: true } }),
    payload({ nativeOptions: { size: 64 * 1024 * 1024 + 1 } }),
    payload({ nativeOptions: { nonzeroPadding: true } }),
    tar([member("native.zip", nativeZip), member("manifest.json", metadata)], {
      singleEndBlock: true,
    }),
    (() => {
      const bytes = payload();
      bytes[bytes.length - 1] = 1;
      return bytes;
    })(),
    tar([
      member("native.zip", nativeZip),
      member("manifest.json", metadata),
      member("extra.bin", Buffer.from("extra")),
    ]),
  ];
  for (const bytes of invalid) rejects(bytes);
});

test("rejects malformed metadata and every digest or size mismatch", () => {
  const invalidManifests = [
    manifest({ extra: true }),
    manifest({ kind: "other" }),
    manifest({ includeFileStorage: false }),
    manifest({ deployment: "bad\ndeployment" }),
    manifest({ createdAt: "not-a-date" }),
    manifest({ sourceCommit: "short" }),
  ];
  for (const value of invalidManifests) {
    rejects(payload({ manifestOverrides: value }));
  }
  rejects(payload({ manifestBytes: Buffer.from("{", "utf8") }));
  rejects(
    payload({ manifestOverrides: { byteLength: nativeZip.length + 1 } }),
    "digest_mismatch",
  );
  rejects(
    payload({ manifestOverrides: { sha256: "b".repeat(64) } }),
    "digest_mismatch",
  );

  const bytes = payload();
  rejects(bytes, "digest_mismatch", {
    expectedPayloadSha256: "0".repeat(64),
  });
  rejects(bytes, "digest_mismatch", {
    expectedNativeZipSha256: "0".repeat(64),
  });
  assert.throws(
    () =>
      decodeNativeDatabasePayload({
        payload: Buffer.alloc(64 * 1024 * 1024 + 1),
        expectedPayloadSha256: "0".repeat(64),
        expectedNativeZipSha256: sha256(nativeZip),
      }),
    (error) =>
      error instanceof ArchiveNativePayloadError &&
      error.code === "invalid_input",
  );
});
