// F1-24: captures.ts in isolation. persistAcquiredDocument's end-to-end
// wiring of this module lives in rawTree.test.mjs and retention.test.mjs;
// this file exercises writeCaptureManifest/readCaptureManifest/
// CaptureConflictError directly, with no archive database and no adapter.
// No real path, institution, account or document content appears in this
// suite; every fixture directory is a temp dir removed on teardown.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CaptureConflictError,
  readCaptureManifest,
  writeCaptureManifest,
} from "../dist/index.js";

/** A throwaway raw-tree root, removed when the test ends. */
function rawTreeRoot(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-captures-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const RETENTION = {
  policy: { kind: "opaque", version: "test-opaque-1", note: "synthetic fixture, no addressable fields" },
  projectionVersion: "1",
  droppedPaths: [],
};

function manifest(overrides = {}) {
  return {
    captureId: "capture-a",
    documentSha256: "a".repeat(64),
    institutionSlug: "marrow-creek",
    acctLast4: "0511",
    docType: "pdf_statement",
    periodStart: "2025-01-01",
    periodEnd: "2025-01-31",
    capturedAt: "2025-02-01T00:00:00.000Z",
    capabilityTier: "pdf_statement",
    gaps: [],
    originalExtension: ".pdf",
    retention: RETENTION,
    ...overrides,
  };
}

test("writeCaptureManifest writes once and reports a repeat of the same capture as a no-op, not a rewrite", (t) => {
  const root = rawTreeRoot(t);
  const m = manifest();

  const first = writeCaptureManifest(root, m);
  assert.equal(first.status, "written");
  assert.ok(existsSync(first.path));
  assert.deepEqual(readCaptureManifest(first.path), m);

  const second = writeCaptureManifest(root, m);
  assert.equal(second.status, "already_exists");
  assert.equal(second.path, first.path);
  assert.equal(second.manifestSha256, first.manifestSha256);
});

test("two different capture ids for byte-identical document content each keep their own manifest", (t) => {
  const root = rawTreeRoot(t);
  const first = writeCaptureManifest(root, manifest({ captureId: "capture-a", capturedAt: "2025-02-01T00:00:00.000Z" }));
  const second = writeCaptureManifest(
    root,
    manifest({ captureId: "capture-b", capturedAt: "2025-05-01T00:00:00.000Z" }),
  );

  assert.notEqual(first.path, second.path);
  assert.equal(readCaptureManifest(first.path).documentSha256, readCaptureManifest(second.path).documentSha256);
  assert.equal(readCaptureManifest(first.path).captureId, "capture-a");
  assert.equal(readCaptureManifest(second.path).captureId, "capture-b");
});

test("reusing a capture id for conflicting content is an explicit error, never a silent overwrite", (t) => {
  const root = rawTreeRoot(t);
  const first = writeCaptureManifest(root, manifest({ captureId: "capture-a" }));

  assert.throws(
    () => writeCaptureManifest(root, manifest({ captureId: "capture-a", docType: "trade_confirmation" })),
    CaptureConflictError,
  );

  // The original capture is untouched.
  assert.deepEqual(readCaptureManifest(first.path).docType, "pdf_statement");
  const filesForCaptureA = readdirSync(join(root, "captures", "marrow-creek", "2025", "02")).filter((f) =>
    f.startsWith("capture-a-"),
  );
  assert.equal(filesForCaptureA.length, 1, "the conflicting attempt never landed a second file");
});

test("captures are laid out by institution and by year/month of capturedAt, discoverable by a plain directory walk", (t) => {
  const root = rawTreeRoot(t);
  const written = writeCaptureManifest(
    root,
    manifest({ institutionSlug: "thistlebrook-trust", capturedAt: "2025-07-15T10:30:00.000Z" }),
  );
  assert.ok(written.path.startsWith(join(root, "captures", "thistlebrook-trust", "2025", "07")));

  const found = readdirSync(root, { recursive: true }).filter((entry) => entry.endsWith(".json"));
  assert.equal(found.length, 1);
});

test("readCaptureManifest round-trips gaps and the retention record intact", (t) => {
  const root = rawTreeRoot(t);
  const m = manifest({
    gaps: [{ periodStart: "2025-01-10", periodEnd: "2025-01-12", reason: "synthetic outage" }],
    retention: {
      policy: { kind: "json_allowlist", version: "v1", fields: ["amount"] },
      projectionVersion: "1",
      droppedPaths: ["sessionToken"],
    },
  });
  const written = writeCaptureManifest(root, m);
  const read = readCaptureManifest(written.path);
  assert.deepEqual(read.gaps, m.gaps);
  assert.deepEqual(read.retention, m.retention);
});
