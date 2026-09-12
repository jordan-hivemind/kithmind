import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import { appendWorkerScanPage, beginWorkerScan } from "../workers/model";
import { parseWorkerRequest, type FsDiscoveryEntry } from "../workers/protocol";

const PROFILE = {
  parserProfileId: "pdf_docqa_v1" as const,
  parserFingerprint: "1".repeat(64),
  extractionConfigurationFingerprint: "3".repeat(64),
  extractorFingerprint: "docling-document-qa:v1",
  recordSchemaFingerprint: "no-records:v1",
  normalizationFingerprint: "docling-pages:v1",
  chunkerFingerprint: "page-aware:v1",
  correctionRevision: "correction:1",
};

function uuid(n: number): string {
  return `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${n.toString().padStart(2, "0")}`;
}

function pdfEntry(
  uri: string,
  externalId: string,
  sha256: string,
  byteLength: number,
): FsDiscoveryEntry {
  return {
    externalId,
    uri,
    sourceModifiedAt: 100,
    content: {
      status: "ready_binary_v1",
      sha256,
      byteLength,
      mediaType: "application/pdf",
      ...PROFILE,
    },
  };
}

function textEntry(
  uri: string,
  externalId: string,
  sha256: string,
  byteLength: number,
): FsDiscoveryEntry {
  return {
    externalId,
    uri,
    sourceModifiedAt: 100,
    content: { status: "ready", sha256, byteLength },
  };
}

function gapEntry(
  uri: string,
  externalId: string,
  code: "encrypted" | "oversized" | "unsupported",
): FsDiscoveryEntry {
  return {
    externalId,
    uri,
    sourceModifiedAt: 100,
    content: { status: "gap", code },
  };
}

const HASH_Q1 = "1".repeat(64);
const HASH_Q2 = "2".repeat(64);
const HASH_DUP = "d".repeat(64);

/**
 * The synthetic tree from docs/plans/2026-09-12-document-cards.md section 11:
 * two ordinary PDFs, one encrypted PDF, one over-limit PDF, four unsupported
 * types (by content, the extension is only a label here), and two
 * byte-identical files. Filesystem-layer classification (magic bytes, the
 * `/Encrypt` marker, size limits) is covered separately in
 * packages/pipeline/test/filesystem.test.mjs; this exercises what
 * `scan.appendPage` does with the entries that classification produces.
 */
const SYNTHETIC_TREE: FsDiscoveryEntry[] = [
  pdfEntry("fs://documents/reports/q1.pdf", uuid(1), HASH_Q1, 2_048),
  pdfEntry("fs://documents/reports/q2.pdf", uuid(2), HASH_Q2, 4_096),
  gapEntry("fs://documents/reports/secret.pdf", uuid(3), "encrypted"),
  gapEntry("fs://documents/reports/huge.pdf", uuid(4), "oversized"),
  gapEntry("fs://documents/reports/sheet.xlsx", uuid(5), "unsupported"),
  gapEntry("fs://documents/reports/memo.docx", uuid(6), "unsupported"),
  gapEntry("fs://documents/reports/photo.jpg", uuid(7), "unsupported"),
  gapEntry("fs://documents/reports/mystery.unknownext", uuid(8), "unsupported"),
  textEntry("fs://documents/reports/dup-a.txt", uuid(9), HASH_DUP, 10),
  textEntry("fs://documents/reports/dup-b.txt", uuid(10), HASH_DUP, 10),
];

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Inventory owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic inventory space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "synthetic-fs",
      name: "Synthetic filesystem",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      binaryProfileId: "pdf_docqa_v1",
      binaryProfileAuditDigest: "1".repeat(64),
      binaryProfileEnabledAt: 10,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "c".repeat(64),
      keyPrefix: "worker",
      name: "Synthetic worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return { userId, spaceId, sourceAccountId, credentialId };
  });
  return {
    t,
    ...ids,
    principal: { userId: ids.userId, credentialId: ids.credentialId },
  };
}

function source(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    protocolVersion: 1 as const,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
}

async function begin(
  f: Awaited<ReturnType<typeof fixture>>,
  requestId: string,
  expectedInventoryEpoch: number,
  now: number,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "scan.begin",
    requestId,
    watcherId: "watcher-1",
    connectorVersion: "fs-v1",
    mode: "normal" as const,
    expectedInventoryEpoch,
  });
  if (request.operation !== "scan.begin") throw new Error("bad test request");
  return await f.t.run((ctx) => beginWorkerScan(ctx, f.principal, request, now));
}

async function appendAll(
  f: Awaited<ReturnType<typeof fixture>>,
  scanId: string,
  requestPrefix: string,
  entries: FsDiscoveryEntry[],
  now: number,
  pageSize = 4,
) {
  for (let start = 0; start < entries.length; start += pageSize) {
    const ordinal = start / pageSize;
    const request = parseWorkerRequest({
      ...source(f),
      operation: "scan.appendPage",
      scanId,
      requestId: `${requestPrefix}-${ordinal}`,
      ordinal,
      entries: entries.slice(start, start + pageSize),
    });
    if (request.operation !== "scan.appendPage") {
      throw new Error("bad test request");
    }
    await f.t.run((ctx) => appendWorkerScanPage(ctx, f.principal, request, now));
  }
}

describe("sourceInventory", () => {
  test("one row per file, every exclusion reason populated, encrypted is not a parser error", async () => {
    const f = await fixture();
    const scan = await begin(f, "scan-1", 0, 1_000);
    await appendAll(f, scan.scanId, "scan-1-page", SYNTHETIC_TREE, 1_100);

    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("sourceInventory")
        .withIndex("by_sourceAccountId_and_identityKeyHash", (q) =>
          q.eq("sourceAccountId", f.sourceAccountId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(SYNTHETIC_TREE.length);

    const byFileName = new Map(rows.map((row) => [row.fileName, row]));
    expect(byFileName.size).toBe(SYNTHETIC_TREE.length);

    for (const fileName of ["q1.pdf", "q2.pdf"]) {
      const row = byFileName.get(fileName)!;
      expect(row.exclusionReason).toBe("extraction_pending");
      expect(row.contentIndexed).toBe(false);
      expect(row.folderPath).toBe("reports");
    }

    expect(byFileName.get("secret.pdf")!.exclusionReason).toBe("encrypted");
    expect(byFileName.get("huge.pdf")!.exclusionReason).toBe("oversized");
    for (const fileName of [
      "sheet.xlsx",
      "memo.docx",
      "photo.jpg",
      "mystery.unknownext",
    ]) {
      expect(byFileName.get(fileName)!.exclusionReason).toBe("unsupported");
    }

    // Every gap row is present (never absent) and carries no content hash.
    for (const fileName of [
      "secret.pdf",
      "huge.pdf",
      "sheet.xlsx",
      "memo.docx",
      "photo.jpg",
      "mystery.unknownext",
    ]) {
      const row = byFileName.get(fileName)!;
      expect(row.contentIndexed).toBe(false);
      expect(row.contentHash).toBeUndefined();
    }

    // Duplicate group: same content hash and byte length, exactly one
    // canonical (extraction_pending) and the other duplicate_of.
    const dupA = byFileName.get("dup-a.txt")!;
    const dupB = byFileName.get("dup-b.txt")!;
    expect(dupA.duplicateGroupId).toBeDefined();
    expect(dupA.duplicateGroupId).toBe(dupB.duplicateGroupId);
    const dupReasons = [dupA.exclusionReason, dupB.exclusionReason].sort();
    expect(dupReasons).toEqual(["duplicate_of", "extraction_pending"]);
  });

  test("a rescan is idempotent", async () => {
    const f = await fixture();
    const scanA = await begin(f, "scan-1", 0, 1_000);
    await appendAll(f, scanA.scanId, "scan-1-page", SYNTHETIC_TREE, 1_100);

    const afterFirstScan = await f.t.run((ctx) =>
      ctx.db.query("sourceInventory").collect(),
    );
    expect(afterFirstScan).toHaveLength(SYNTHETIC_TREE.length);
    const firstSeen = new Map(
      afterFirstScan.map((row) => [row.fileName, row.firstSeenScanId]),
    );

    // Scan A's open state expires after WORKER_SCAN_IDLE_MS with no further
    // activity, which is what lets a restarted worker begin a fresh scan
    // without an explicit seal/reconcile of the one it abandoned.
    const restartedAt = 1_100 + 31 * 60 * 1_000;
    const scanB = await begin(f, "scan-2", 1, restartedAt);
    expect(scanB.scanId).not.toBe(scanA.scanId);
    await appendAll(
      f,
      scanB.scanId,
      "scan-2-page",
      SYNTHETIC_TREE,
      restartedAt + 100,
    );

    const afterSecondScan = await f.t.run((ctx) =>
      ctx.db.query("sourceInventory").collect(),
    );
    expect(afterSecondScan).toHaveLength(SYNTHETIC_TREE.length);
    for (const row of afterSecondScan) {
      expect(row.firstSeenScanId).toBe(firstSeen.get(row.fileName));
      expect(row.lastSeenScanId).toBe(scanB.scanId);
    }
  });
});
