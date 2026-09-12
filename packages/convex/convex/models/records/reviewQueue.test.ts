import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  stagePages,
} from "../provenance/model";
import { appendWorkerScanPage, beginWorkerScan } from "../workers/model";
import { parseWorkerRequest, type FsDiscoveryEntry } from "../workers/protocol";

import { listReviewQueue } from "./reviewQueue";

// Synthetic fixture only. Nothing here describes a real file, document or
// account.

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

function uuid(n: number): string {
  return `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${n.toString().padStart(2, "0")}`;
}

const HASH_Q1 = "1".repeat(64);
const HASH_Q2 = "2".repeat(64);
const HASH_DUP = "d".repeat(64);

/**
 * 2 ordinary files (never content indexed, so both read as
 * `extraction_pending`), 1 encrypted, 1 oversized, 4 unsupported, and one
 * duplicate group of 2 byte-identical files. Same shape as
 * `documents/inventory.test.ts`'s synthetic tree, reused here so the review
 * queue's `skipped_by_type` and `duplicate_group` classes have a known,
 * already-verified count to check against: 10 rows total, `unsupported`: 4,
 * `encrypted`: 1, `oversized`: 1, `extraction_pending`: 3 (the two ordinary
 * files plus the duplicate group's canonical member), `duplicate_of`: 1.
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

type T = ReturnType<typeof convexTest>;

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Review queue owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic review queue",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "synthetic-review-queue",
      name: "Synthetic review queue",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 1_000_000,
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
    // A second space and account the caller is not authorized for, per
    // `documents/inventory.test.ts`'s "refuses a source account outside the
    // caller's authorized spaces" test.
    const otherUserId = await ctx.db.insert("users", { name: "Other owner" });
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
      connector: "synthetic",
      accountId: "other",
      name: "Other",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 1_000_000,
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
  return { t, ...ids, principal: { userId: ids.userId, credentialId: ids.credentialId } };
}

async function seedInventory(f: Awaited<ReturnType<typeof fixture>>) {
  const source = {
    protocolVersion: 1 as const,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
  const principal = f.principal;
  const beginRequest = parseWorkerRequest({
    ...source,
    operation: "scan.begin",
    requestId: "scan-1",
    watcherId: "watcher-1",
    connectorVersion: "fs-v1",
    mode: "normal" as const,
    expectedInventoryEpoch: 0,
  });
  if (beginRequest.operation !== "scan.begin") throw new Error("bad test request");
  const scan = await f.t.run((ctx) =>
    beginWorkerScan(ctx, principal, beginRequest, 1_000),
  );
  for (let start = 0; start < SYNTHETIC_TREE.length; start += 4) {
    const ordinal = start / 4;
    const appendRequest = parseWorkerRequest({
      ...source,
      operation: "scan.appendPage",
      scanId: scan.scanId,
      requestId: `scan-1-page-${ordinal}`,
      ordinal,
      entries: SYNTHETIC_TREE.slice(start, start + 4),
    });
    if (appendRequest.operation !== "scan.appendPage") {
      throw new Error("bad test request");
    }
    await f.t.run((ctx) => appendWorkerScanPage(ctx, principal, appendRequest, 1_100));
  }
}

/** One admitted document with retained text, built the same way
 * `cardQueue.test.ts`'s `seedItem` does, but returning both ids: this
 * module's rows reference a document and a processing generation, never a
 * field value, and cardFieldDrops requires both ids to be valid. */
async function seedDocumentAndGeneration(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<{
  sourceItemId: Id<"sourceItems">;
  processingGenerationId: Id<"processingGenerations">;
}> {
  const title = "Synthetic Document";
  return await f.t.run(async (ctx) => {
    const sourceItem = await createOrGetSourceItem(ctx, {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      externalId: "synthetic://review-queue/doc-1",
    });
    const revision = await createOrGetRevision(ctx, {
      spaceId: f.spaceId,
      sourceItemId: sourceItem._id,
      mediaType: "text/plain",
      inlineText: title,
      capturedAt: 1_700_000_000_000,
      userId: f.userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId: f.spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: "plain:v1",
      text: title,
    });
    await stagePages(ctx, {
      spaceId: f.spaceId,
      sourceTextVersionId: textVersion._id,
      pages: [{ ordinal: 0, start: 0, end: title.length, text: title }],
    });
    const processingGenerationId = await ctx.db.insert("processingGenerations", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: sourceItem._id,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      processingFingerprint: "review-queue-base:1",
      extractionFingerprint: "plain:v1",
      extractorFingerprint: "synthetic:v1",
      recordSchemaFingerprint: "records:v1",
      normalizationFingerprint: "exact:v1",
      chunkerFingerprint: "none:v1",
      correctionRevision: "one",
      desiredProcessingEpoch: 1,
      state: "ready",
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 0,
      expectedDocumentCount: 1,
      expectedChunkCount: 0,
      expectedEventCount: 0,
      expectedObservationCount: 0,
      actualPageCount: 1,
      actualEvidenceSpanCount: 0,
      actualDocumentCount: 1,
      actualChunkCount: 0,
      embeddingStatus: "unavailable",
      activatedAt: 100,
    });
    return { sourceItemId: sourceItem._id, processingGenerationId };
  });
}

/** A marker that must never appear in `list_review_queue`'s output. It is
 * planted only in `cardFieldDrops.reason`, a field this module never
 * projects, so its absence from the result proves the tool never surfaces a
 * field's value, only its name and closed failure code. */
const FORBIDDEN_VALUE_MARKER = "the-actual-amount-was-USD-42901.17";

async function seedDrops(
  f: Awaited<ReturnType<typeof fixture>>,
  refs: { sourceItemId: Id<"sourceItems">; processingGenerationId: Id<"processingGenerations"> },
) {
  await f.t.run(async (ctx) => {
    const base = {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: refs.sourceItemId,
      processingGenerationId: refs.processingGenerationId,
      createdAt: 1_200,
    };
    await ctx.db.insert("cardFieldDrops", {
      ...base,
      recordKind: "document_card",
      kind: "field_dropped",
      fieldKey: "amount",
      code: "value_not_in_span",
      reason: FORBIDDEN_VALUE_MARKER,
    });
    await ctx.db.insert("cardFieldDrops", {
      ...base,
      recordKind: "document_card",
      kind: "field_dropped",
      fieldKey: "total",
      code: "value_not_in_span",
      reason: FORBIDDEN_VALUE_MARKER,
    });
    await ctx.db.insert("cardFieldDrops", {
      ...base,
      recordKind: "document_card",
      kind: "field_dropped",
      fieldKey: "effective_date",
      code: "date_ambiguous",
      reason: "date_ambiguous",
    });
    await ctx.db.insert("cardFieldDrops", {
      ...base,
      recordKind: "document_card",
      kind: "card_gate_failed",
      fieldKey: "title",
      code: "required_field_absent",
      reason: "required_field_absent",
    });
    await ctx.db.insert("cardFieldDrops", {
      ...base,
      recordKind: "safe_note_card",
      kind: "card_gate_failed",
      fieldKey: "investment_amount",
      code: "required_field_absent",
      reason: "required_field_absent",
    });
  });
}

async function seedQueueState(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.run((ctx) =>
    ctx.db.insert("cardExtractionQueueStates", {
      spaceId: f.spaceId,
      kind: "document_card",
      phase: "running",
      cursor: null,
      dailyDocumentBudget: 10,
      weeklyDocumentBudget: 50,
      weeklyCostBudgetMicroUsd: 50_000_000,
      dayWindowStart: 0,
      weekWindowStart: 0,
      documentsProcessedToday: 4,
      documentsProcessedThisWeek: 4,
      costMicroUsdThisWeek: 12_000,
      extractedCount: 5,
      gateFailedCount: 2,
      skippedCount: 1,
      startedAt: 100,
      updatedAt: 200,
    }),
  );
}

async function fullFixture() {
  const f = await fixture();
  await seedInventory(f);
  const refs = await seedDocumentAndGeneration(f);
  await seedDrops(f, refs);
  await seedQueueState(f);
  return f;
}

describe("listReviewQueue", () => {
  test("counts match for every class populated in the fixture", async () => {
    const f = await fullFixture();
    const result = await f.t.run((ctx) =>
      listReviewQueue(ctx, [f.spaceId], { sourceAccountId: f.sourceAccountId }),
    );
    expect(result.rows).toEqual([]);
    expect(result.isDone).toBe(true);
    expect(result.cursor).toBeUndefined();

    expect(result.counts.skippedByType.total).toBe(SYNTHETIC_TREE.length);
    expect(result.counts.skippedByType.truncated).toBe(false);
    expect(result.counts.skippedByType.byExclusionReason).toEqual({
      unsupported: 4,
      encrypted: 1,
      oversized: 1,
      extraction_pending: 3,
      duplicate_of: 1,
    });

    expect(result.counts.duplicateGroup).toEqual({ total: 1, truncated: false });

    expect(result.counts.fieldDropped.total).toBe(3);
    expect(result.counts.fieldDropped.truncated).toBe(false);
    expect(result.counts.fieldDropped.byCode).toEqual({
      value_not_in_span: 2,
      date_ambiguous: 1,
    });

    expect(result.counts.cardGateFailed.total).toBe(2);
    expect(result.counts.cardGateFailed.truncated).toBe(false);
    expect(result.counts.cardGateFailed.byRecordKind).toEqual({
      document_card: 1,
      safe_note_card: 1,
    });

    expect(result.counts.queueStatus).toHaveLength(1);
    expect(result.counts.queueStatus[0]).toMatchObject({
      kind: "document_card",
      phase: "running",
      extractedCount: 5,
      gateFailedCount: 2,
      skippedCount: 1,
    });
  });

  test("the skipped_by_type detail page is bounded and cursor-paged", async () => {
    const f = await fullFixture();
    const firstPage = await f.t.run((ctx) =>
      listReviewQueue(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        class: "skipped_by_type",
        limit: 3,
      }),
    );
    expect(firstPage.rows).toHaveLength(3);
    expect(firstPage.isDone).toBe(false);
    expect(firstPage.cursor).toBeDefined();
    // Counts still report the whole scope, not just this page.
    expect(firstPage.counts.skippedByType.total).toBe(SYNTHETIC_TREE.length);

    const seen: unknown[] = [...firstPage.rows];
    let cursor = firstPage.cursor;
    while (cursor) {
      const page = await f.t.run((ctx) =>
        listReviewQueue(ctx, [f.spaceId], {
          sourceAccountId: f.sourceAccountId,
          class: "skipped_by_type",
          limit: 3,
          cursor,
        }),
      );
      seen.push(...page.rows);
      cursor = page.cursor;
      if (page.isDone) break;
    }
    expect(seen).toHaveLength(SYNTHETIC_TREE.length);
  });

  test("a value never appears in field_dropped or card_gate_failed rows", async () => {
    const f = await fullFixture();
    const dropped = await f.t.run((ctx) =>
      listReviewQueue(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        class: "field_dropped",
      }),
    );
    expect(dropped.rows).toHaveLength(3);
    for (const row of dropped.rows as Array<Record<string, unknown>>) {
      expect(row.kind).toBe("field_dropped");
      expect(Object.keys(row).sort()).toEqual(
        [
          "code",
          "createdAt",
          "dropId",
          "fieldKey",
          "kind",
          "processingGenerationId",
          "recordKind",
          "sourceItemId",
        ].sort(),
      );
    }
    const serialized = JSON.stringify(dropped);
    expect(serialized).not.toContain(FORBIDDEN_VALUE_MARKER);
    expect(serialized).toContain("value_not_in_span");
    expect(serialized).toContain("amount");

    const gateFailed = await f.t.run((ctx) =>
      listReviewQueue(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        class: "card_gate_failed",
      }),
    );
    expect(gateFailed.rows).toHaveLength(2);
    for (const row of gateFailed.rows as Array<Record<string, unknown>>) {
      expect(row.kind).toBe("card_gate_failed");
    }
    expect(JSON.stringify(gateFailed)).not.toContain(FORBIDDEN_VALUE_MARKER);
  });

  test("the duplicate_group detail lists both members", async () => {
    const f = await fullFixture();
    const result = await f.t.run((ctx) =>
      listReviewQueue(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        class: "duplicate_group",
      }),
    );
    expect(result.isDone).toBe(true);
    const fileNames = (result.rows as Array<{ fileName: string }>)
      .map((row) => row.fileName)
      .sort();
    expect(fileNames).toEqual(["dup-a.txt", "dup-b.txt"]);
  });

  test("the queue_status detail returns the per-kind summary", async () => {
    const f = await fullFixture();
    const result = await f.t.run((ctx) =>
      listReviewQueue(ctx, [f.spaceId], {
        sourceAccountId: f.sourceAccountId,
        class: "queue_status",
      }),
    );
    expect(result.isDone).toBe(true);
    expect(result.cursor).toBeUndefined();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "document_card",
      phase: "running",
      extractedCount: 5,
    });
  });

  test("an unauthorized account yields the empty, non-enumerating result", async () => {
    const f = await fullFixture();
    const result = await f.t.run((ctx) =>
      listReviewQueue(ctx, [f.spaceId], {
        sourceAccountId: f.otherSourceAccountId,
        class: "field_dropped",
      }),
    );
    expect(result.rows).toEqual([]);
    expect(result.cursor).toBeUndefined();
    expect(result.isDone).toBe(true);
    expect(result.counts).toEqual({
      skippedByType: { total: 0, byExclusionReason: {}, truncated: false },
      fieldDropped: { total: 0, byCode: {}, truncated: false },
      cardGateFailed: { total: 0, byRecordKind: {}, truncated: false },
      duplicateGroup: { total: 0, truncated: false },
      queueStatus: [],
    });
  });
});
