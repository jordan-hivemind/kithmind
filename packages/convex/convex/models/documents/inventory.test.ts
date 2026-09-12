import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { listInventory } from "./inventory";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  reconcileWorkerScan,
  sealWorkerScan,
} from "../workers/model";
import { parseWorkerRequest, type FsDiscoveryEntry } from "../workers/protocol";
import {
  activateGeneration,
  admitSourceRevision,
  claimJob,
  createGenerationTextVersion,
  failJob,
  requeueJob,
  stageGeneration,
  stageGenerationChunks,
  stageGenerationDocuments,
  stageGenerationEvidenceSpans,
  stageGenerationPages,
} from "../ingestion/model";

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

function permissionsRestrictedPdfEntry(
  uri: string,
  externalId: string,
  sha256: string,
  byteLength: number,
  encryptionRevision: number,
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
      permissionsRestricted: true,
      encryptionRevision,
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
    // A second space and account this fixture's reader does not belong to,
    // for the "non-member space refused" read test.
    const otherUserId = await ctx.db.insert("users", {
      name: "Other space owner",
    });
    const otherSpaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Other synthetic space",
      createdBy: otherUserId,
    });
    await ctx.db.insert("spaceMembers", {
      spaceId: otherSpaceId,
      userId: otherUserId,
      role: "owner",
    });
    const otherSourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId: otherSpaceId,
      connector: "fs",
      accountId: "other-fs",
      name: "Other filesystem",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: otherUserId,
    });
    return {
      userId,
      spaceId,
      sourceAccountId,
      credentialId,
      otherSpaceId,
      otherSourceAccountId,
    };
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

async function sealHealthy(
  f: Awaited<ReturnType<typeof fixture>>,
  scanId: string,
  requestId: string,
  expectedPageCount: number,
  now: number,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "scan.seal",
    scanId,
    requestId,
    expectedPageCount,
    health: { status: "healthy" as const },
  });
  if (request.operation !== "scan.seal") throw new Error("bad test request");
  return await f.t.run((ctx) => sealWorkerScan(ctx, f.principal, request, now));
}

async function reconcileToCompletion(
  f: Awaited<ReturnType<typeof fixture>>,
  scanId: string,
  requestId: string,
  expectedInventoryEpoch: number,
  now: number,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "scan.reconcile",
    scanId,
    requestId,
    expectedInventoryEpoch,
    ordinal: 0,
    maxItems: 50,
  });
  if (request.operation !== "scan.reconcile") {
    throw new Error("bad test request");
  }
  const result = await f.t.run((ctx) =>
    reconcileWorkerScan(ctx, f.principal, request, now),
  );
  if (!result.done) throw new Error("expected reconcile to finish in one call");
  return result;
}

/** Scans the whole SYNTHETIC_TREE (or a subset) through seal and a completed,
 * healthy reconcile, the only path that may set `missingSinceScanId`. */
async function completeScan(
  f: Awaited<ReturnType<typeof fixture>>,
  label: string,
  expectedInventoryEpoch: number,
  entries: FsDiscoveryEntry[],
  now: number,
) {
  const scan = await begin(f, `${label}-begin`, expectedInventoryEpoch, now);
  await appendAll(f, scan.scanId, `${label}-page`, entries, now + 10);
  const pageCount = Math.ceil(entries.length / 4);
  await sealHealthy(f, scan.scanId, `${label}-seal`, pageCount, now + 20);
  const result = await reconcileToCompletion(
    f,
    scan.scanId,
    `${label}-reconcile`,
    scan.inventoryEpoch,
    now + 30,
  );
  expect(result.state).toBe("enumerated");
  return scan;
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

describe("listInventory", () => {
  async function seededInventory() {
    const f = await fixture();
    const scan = await begin(f, "scan-1", 0, 1_000);
    await appendAll(f, scan.scanId, "scan-1-page", SYNTHETIC_TREE, 1_100);
    return f;
  }

  test("finds a present file by exact name, never content indexed", async () => {
    const f = await seededInventory();
    const result = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        fileName: "q1.pdf",
      }),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      fileName: "q1.pdf",
      folderPath: "reports",
      contentIndexed: false,
      exclusionReason: "extraction_pending",
    });
    expect(result.isDone).toBe(true);
    expect(result.counts).toMatchObject({ total: 1, truncated: false });
  });

  test("lists a folder paged with counts that survive truncation", async () => {
    const f = await seededInventory();
    const firstPage = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        folderPath: "reports",
        limit: 5,
      }),
    );
    expect(firstPage.rows).toHaveLength(5);
    expect(firstPage.isDone).toBe(false);
    expect(firstPage.cursor).toBeDefined();
    // The folder holds all 10 synthetic files; counts report the whole
    // folder even though this page only carries 5 rows, so a truncated page
    // is never mistaken for a complete folder.
    expect(firstPage.counts.total).toBe(SYNTHETIC_TREE.length);
    expect(firstPage.counts.truncated).toBe(false);
    const reasonTotal = Object.values(firstPage.counts.byExclusionReason).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(reasonTotal + firstPage.counts.contentIndexed).toBe(
      SYNTHETIC_TREE.length,
    );
    expect(firstPage.counts.byExclusionReason.unsupported).toBe(4);

    const secondPage = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        folderPath: "reports",
        limit: 5,
        cursor: firstPage.cursor,
      }),
    );
    expect(secondPage.rows).toHaveLength(5);
    expect(secondPage.isDone).toBe(true);
    expect(secondPage.cursor).toBeUndefined();
    const allFileNames = new Set(
      [...firstPage.rows, ...secondPage.rows].map((row) => row.fileName),
    );
    expect(allFileNames.size).toBe(SYNTHETIC_TREE.length);
  });

  test("filters to one exclusion reason", async () => {
    const f = await seededInventory();
    const result = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        exclusionReason: "unsupported",
      }),
    );
    expect(result.rows).toHaveLength(4);
    expect(
      result.rows.every((row) => row.exclusionReason === "unsupported"),
    ).toBe(true);
    expect(result.counts.total).toBe(4);
    expect(result.counts.byExclusionReason).toEqual({ unsupported: 4 });
  });

  test("lists a duplicate group by the group id of one of its members", async () => {
    const f = await seededInventory();
    const named = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        fileName: "dup-a.txt",
      }),
    );
    const groupId = named.rows[0]!.duplicateGroupId!;
    expect(groupId).toBeDefined();

    const group = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        duplicateGroupId: groupId,
      }),
    );
    expect(group.rows.map((row) => row.fileName).sort()).toEqual([
      "dup-a.txt",
      "dup-b.txt",
    ]);
    const reasons = group.rows.map((row) => row.exclusionReason).sort();
    expect(reasons).toEqual(["duplicate_of", "extraction_pending"]);
    expect(group.counts.total).toBe(2);
  });

  test("refuses a source account outside the caller's authorized spaces", async () => {
    const f = await seededInventory();
    // The caller is only authorized for f.spaceId; f.otherSourceAccountId
    // belongs to f.otherSpaceId, so this must read as empty rather than
    // trusting the caller-supplied sourceAccountId on its own.
    const result = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.otherSourceAccountId,
        folderPath: "reports",
      }),
    );
    expect(result.rows).toEqual([]);
    expect(result.isDone).toBe(true);
    expect(result.counts).toEqual({
      total: 0,
      contentIndexed: 0,
      byExclusionReason: {},
      truncated: false,
    });
  });
});

describe("duplicate canonicality (P2-70a2)", () => {
  test("the canonical label is deterministic: the lowest identityKeyHash in the group", async () => {
    const f = await fixture();
    const scan = await begin(f, "scan-1", 0, 1_000);
    await appendAll(f, scan.scanId, "scan-1-page", SYNTHETIC_TREE, 1_100);

    const rows = await f.t.run((ctx) =>
      ctx.db.query("sourceInventory").collect(),
    );
    const byFileName = new Map(rows.map((row) => [row.fileName, row]));
    const dupA = byFileName.get("dup-a.txt")!;
    const dupB = byFileName.get("dup-b.txt")!;
    const canonical =
      dupA.identityKeyHash < dupB.identityKeyHash ? dupA : dupB;
    const other = canonical === dupA ? dupB : dupA;
    expect(canonical.exclusionReason).toBe("extraction_pending");
    expect(other.exclusionReason).toBe("duplicate_of");
  });
});

describe("missingSinceScanId (P2-70a2)", () => {
  test("a complete scan missing one file marks it, a later scan clears it", async () => {
    const f = await fixture();
    await completeScan(f, "full", 0, SYNTHETIC_TREE, 1_000);

    const afterFirstScan = await f.t.run((ctx) =>
      ctx.db.query("sourceInventory").collect(),
    );
    expect(
      afterFirstScan.every((row) => row.missingSinceScanId === undefined),
    ).toBe(true);

    // q2.pdf is left out of the second scan entirely.
    const withoutQ2 = SYNTHETIC_TREE.filter(
      (entry) => !entry.uri.endsWith("q2.pdf"),
    );
    const secondScan = await completeScan(f, "missing-one", 1, withoutQ2, 2_000);

    const afterSecondScan = await f.t.run((ctx) =>
      ctx.db.query("sourceInventory").collect(),
    );
    const byFileName = new Map(
      afterSecondScan.map((row) => [row.fileName, row]),
    );
    expect(byFileName.get("q2.pdf")!.missingSinceScanId).toBe(
      secondScan.scanId,
    );
    // Leaves everything else on the row: still present and excluded for the
    // same reason it always was, not silently dropped.
    expect(byFileName.get("q2.pdf")!.exclusionReason).toBe(
      "extraction_pending",
    );
    for (const [fileName, row] of byFileName) {
      if (fileName !== "q2.pdf") {
        expect(row.missingSinceScanId).toBeUndefined();
      }
    }

    // q2.pdf reappears in a third, complete scan: the mark clears.
    await completeScan(f, "reappears", 2, SYNTHETIC_TREE, 3_000);
    const afterThirdScan = await f.t.run((ctx) =>
      ctx.db.query("sourceInventory").collect(),
    );
    const q2AfterThird = afterThirdScan.find(
      (row) => row.fileName === "q2.pdf",
    )!;
    expect(q2AfterThird.missingSinceScanId).toBeUndefined();
    expect(q2AfterThird.lastSeenScanId).not.toBe(secondScan.scanId);
  });
});

describe("parse_failed exclusion (P2-70a2)", () => {
  const PROCESSING = {
    extractionFingerprint: "text/plain:v1",
    extractorFingerprint: "none:v1",
    recordSchemaFingerprint: "documents:v1",
    normalizationFingerprint: "none:v1",
    chunkerFingerprint: "whole:v1",
    correctionRevision: "0",
    expectedPageCount: 1,
    expectedEvidenceSpanCount: 1,
    expectedDocumentCount: 1,
    expectedChunkCount: 1,
  };

  function admissionInput(
    f: Awaited<ReturnType<typeof fixture>>,
    requestId: string,
  ) {
    return {
      principal: f.principal,
      sourceAccountId: f.sourceAccountId,
      requestId,
      expectedDesiredProcessingEpoch: 0,
      source: {
        externalId: "job-fixture-1",
        title: "Synthetic parse-failed source",
        docType: "note",
        uri: "synthetic://job-fixture-1",
        capturedAt: 1_000,
        mediaType: "text/plain",
        inlineText: "alpha beta",
      },
      processing: PROCESSING,
    };
  }

  async function stageAndActivate(
    f: Awaited<ReturnType<typeof fixture>>,
    admitted: Awaited<ReturnType<typeof admitSourceRevision>>,
    token: string,
    now: number,
  ) {
    const lease = await f.t.run((ctx) =>
      claimJob(ctx, {
        principal: f.principal,
        jobId: admitted.ingestJobId,
        leaseToken: token,
        leaseDurationMs: 50,
        now,
      }),
    );
    if (!("leaseEpoch" in lease)) throw new Error("expected lease");
    const leaseArgs = {
      principal: f.principal,
      jobId: admitted.ingestJobId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: token,
      now: now + 1,
    };
    await f.t.run((ctx) =>
      createGenerationTextVersion(ctx, { ...leaseArgs, text: "alpha beta" }),
    );
    const pages = await f.t.run((ctx) =>
      stageGenerationPages(ctx, {
        ...leaseArgs,
        pages: [{ ordinal: 0, start: 0, end: 10, text: "alpha beta" }],
      }),
    );
    if (!("ids" in pages)) throw new Error("expected pages");
    const spans = await f.t.run((ctx) =>
      stageGenerationEvidenceSpans(ctx, {
        ...leaseArgs,
        spans: [
          {
            sourcePageId: pages.ids[0]!._id,
            ordinal: 0,
            start: 0,
            end: 5,
            locator: { kind: "page" as const, label: "1" },
          },
        ],
      }),
    );
    if (!("ids" in spans)) throw new Error("expected spans");
    const documents = await f.t.run((ctx) =>
      stageGenerationDocuments(ctx, {
        ...leaseArgs,
        documents: [
          {
            documentKey: "document-0",
            title: "Synthetic document",
            docType: "note",
            capturedAt: 1_000,
            evidenceSpanIds: [spans.ids[0]!._id],
          },
        ],
      }),
    );
    if (!("ids" in documents)) throw new Error("expected documents");
    await f.t.run((ctx) =>
      stageGenerationChunks(ctx, {
        ...leaseArgs,
        chunks: [
          {
            documentId: documents.ids[0]!._id,
            ordinal: 0,
            text: "alpha beta",
            evidenceSpanIds: [spans.ids[0]!._id],
          },
        ],
      }),
    );
    await f.t.run((ctx) => stageGeneration(ctx, leaseArgs));
    // The first lease (50ms, from `now`) has expired by `now + 101`, so this
    // reclaims the staged job the same way a restarted worker would.
    const staged = await f.t.run((ctx) =>
      claimJob(ctx, {
        principal: f.principal,
        jobId: admitted.ingestJobId,
        leaseToken: `${token}-activate`,
        leaseDurationMs: 1_000,
        now: now + 101,
      }),
    );
    if (!("leaseEpoch" in staged)) throw new Error("expected staged lease");
    await f.t.run((ctx) =>
      activateGeneration(ctx, {
        principal: f.principal,
        jobId: admitted.ingestJobId,
        leaseEpoch: staged.leaseEpoch,
        leaseToken: `${token}-activate`,
        now: now + 102,
      }),
    );
  }

  test("a non-retryable job failure marks parse_failed with its failure class; a later success clears it", async () => {
    const f = await fixture();
    const admitted = await f.t.run((ctx) =>
      admitSourceRevision(ctx, admissionInput(f, "request-1")),
    );
    // The row an earlier fs scan would already have created for this same
    // file, tied to the job's sourceItemId.
    const scan = await begin(f, "scan-1", 0, 900);
    const inventoryId = await f.t.run((ctx) =>
      ctx.db.insert("sourceInventory", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: admitted.sourceItemId,
        identityKeyHash: "job-fixture-identity",
        relativePath: "job-fixture.txt",
        folderPath: "",
        fileName: "job-fixture.txt",
        modifiedAt: 900,
        contentIndexed: false,
        exclusionReason: "extraction_pending" as const,
        firstSeenScanId: scan.scanId as Id<"workerSourceScans">,
        lastSeenScanId: scan.scanId as Id<"workerSourceScans">,
      }),
    );

    const lease = await f.t.run((ctx) =>
      claimJob(ctx, {
        principal: f.principal,
        jobId: admitted.ingestJobId,
        leaseToken: "lease-1",
        leaseDurationMs: 1_000,
        now: 1_000,
      }),
    );
    if (!("leaseEpoch" in lease)) throw new Error("expected lease");
    const failed = await f.t.run((ctx) =>
      failJob(ctx, {
        principal: f.principal,
        jobId: admitted.ingestJobId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken: "lease-1",
        now: 1_001,
        code: "source_bytes_invalid",
        message: "The retained source bytes no longer match their manifest",
        retryable: false,
      }),
    );
    expect(failed.retryable).toBe(false);

    const afterFailure = await f.t.run((ctx) => ctx.db.get(inventoryId));
    expect(afterFailure?.exclusionReason).toBe("parse_failed");
    expect(afterFailure?.exclusionDetail).toBe("source_bytes_invalid");

    const queueAfterFailure = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        exclusionReason: "parse_failed",
      }),
    );
    expect(queueAfterFailure.counts.byExclusionReason.parse_failed).toBe(1);
    expect(queueAfterFailure.rows[0]?.fileName).toBe("job-fixture.txt");

    // A later job for the same file succeeds.
    await f.t.run((ctx) =>
      requeueJob(ctx, {
        principal: f.principal,
        jobId: admitted.ingestJobId,
        now: 1_100,
      }),
    );
    await stageAndActivate(f, admitted, "lease-2", 1_200);

    const afterSuccess = await f.t.run((ctx) => ctx.db.get(inventoryId));
    expect(afterSuccess?.exclusionReason).toBe("extraction_pending");
    expect(afterSuccess?.exclusionDetail).toBeUndefined();

    const queueAfterSuccess = await f.t.run((ctx) =>
      listInventory(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        exclusionReason: "parse_failed",
      }),
    );
    expect(
      queueAfterSuccess.counts.byExclusionReason.parse_failed,
    ).toBeUndefined();
  });

  test("a failed job never excludes a file whose row is already content indexed", async () => {
    const f = await fixture();
    const admitted = await f.t.run((ctx) =>
      admitSourceRevision(ctx, admissionInput(f, "request-1")),
    );
    const scan = await begin(f, "scan-1", 0, 900);
    const inventoryId = await f.t.run((ctx) =>
      ctx.db.insert("sourceInventory", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: admitted.sourceItemId,
        identityKeyHash: "job-fixture-identity",
        relativePath: "job-fixture.txt",
        folderPath: "",
        fileName: "job-fixture.txt",
        modifiedAt: 900,
        contentIndexed: true,
        firstSeenScanId: scan.scanId as Id<"workerSourceScans">,
        lastSeenScanId: scan.scanId as Id<"workerSourceScans">,
      }),
    );

    const lease = await f.t.run((ctx) =>
      claimJob(ctx, {
        principal: f.principal,
        jobId: admitted.ingestJobId,
        leaseToken: "lease-1",
        leaseDurationMs: 1_000,
        now: 1_000,
      }),
    );
    if (!("leaseEpoch" in lease)) throw new Error("expected lease");
    await f.t.run((ctx) =>
      failJob(ctx, {
        principal: f.principal,
        jobId: admitted.ingestJobId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken: "lease-1",
        now: 1_001,
        code: "source_bytes_invalid",
        message: "The retained source bytes no longer match their manifest",
        retryable: false,
      }),
    );

    const row = await f.t.run((ctx) => ctx.db.get(inventoryId));
    expect(row?.exclusionReason).toBeUndefined();
    expect(row?.exclusionDetail).toBeUndefined();
  });
});

describe("permissionsRestricted (P2-77)", () => {
  test("a permissions-only PDF is admitted (not excluded as encrypted) with the flag and revision detail set", async () => {
    const f = await fixture();
    const scan = await begin(f, "scan-1", 0, 1_000);
    await appendAll(
      f,
      scan.scanId,
      "scan-1-page",
      [
        permissionsRestrictedPdfEntry(
          "fs://documents/reports/permissions-only.pdf",
          uuid(1),
          HASH_Q1,
          2_048,
          3,
        ),
      ],
      1_100,
    );

    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("sourceInventory")
        .withIndex("by_sourceAccountId_and_identityKeyHash", (q) =>
          q.eq("sourceAccountId", f.sourceAccountId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    // Not excluded as encrypted: this is the same "not yet content indexed"
    // pending state any freshly admitted PDF carries, per the
    // "sourceInventory" describe block above.
    expect(row?.exclusionReason).toBe("extraction_pending");
    expect(row?.permissionsRestricted).toBe(true);
    expect(row?.permissionsDetail).toBe(
      "standard security handler revision 3 (empty user password)",
    );
  });

  test("an ordinary admitted PDF leaves permissionsRestricted unset", async () => {
    const f = await fixture();
    const scan = await begin(f, "scan-1", 0, 1_000);
    await appendAll(
      f,
      scan.scanId,
      "scan-1-page",
      [pdfEntry("fs://documents/reports/q1.pdf", uuid(1), HASH_Q1, 2_048)],
      1_100,
    );

    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("sourceInventory")
        .withIndex("by_sourceAccountId_and_identityKeyHash", (q) =>
          q.eq("sourceAccountId", f.sourceAccountId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.permissionsRestricted).toBe(false);
    expect(row?.permissionsDetail).toBeUndefined();
  });
});
