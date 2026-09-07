import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import { sha256Utf8 } from "./model";
import { auditLegacyProvenancePage } from "./migrations";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Audit space",
      createdBy: userId,
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "manual",
      accountId: "audit",
      name: "Audit",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash: "a".repeat(64),
      lifecycle: "available",
      originalLinkAvailable: false,
      desiredProcessingEpoch: 0,
    });
    return { userId, spaceId, sourceAccountId, sourceItemId };
  });
  return { t, ...ids };
}

async function insertLegacyRevision(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
) {
  return await f.t.run(async (ctx) =>
    ctx.db.insert("sourceRevisions", {
      spaceId: f.spaceId,
      sourceItemId: f.sourceItemId,
      contentHash: await sha256Utf8(text),
      byteLength: new TextEncoder().encode(text).byteLength,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: 1,
      userId: f.userId,
    }),
  );
}

describe("legacy provenance audit", () => {
  test("paginates without mutation or content disclosure", async () => {
    const f = await fixture();
    await insertLegacyRevision(f, "private-first");
    await insertLegacyRevision(f, "private-second");
    const before = await f.t.run((ctx) =>
      ctx.db.query("sourceRevisions").collect(),
    );
    const first = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_revisions",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(first).toMatchObject({
      scope: "representations_parents_inline_hashes_only",
      binaryEnablementReady: false,
      inspected: 1,
      validCount: 1,
      implicitLegacyCount: 1,
      invalidCount: 0,
      isDone: false,
    });
    expect(JSON.stringify(first)).not.toContain("private-");
    const second = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_revisions",
        cursor: first.continueCursor,
        maxItems: 1,
      }),
    );
    expect(second).toMatchObject({
      inspected: 1,
      validCount: 1,
      binaryEnablementReady: false,
      isDone: true,
    });
    expect(
      await f.t.run((ctx) => ctx.db.query("sourceRevisions").collect()),
    ).toEqual(before);
  });

  test("reports mixed representations, hash damage, and broken parents by ID", async () => {
    const f = await fixture();
    const mixedId = await f.t.run((ctx) =>
      ctx.db.insert("sourceRevisions", {
        spaceId: f.spaceId,
        sourceItemId: f.sourceItemId,
        representation: "archived_binary_v1",
        contentHashAuthority: "worker_asserted",
        contentHash: "b".repeat(64),
        byteLength: 10,
        mediaType: "application/pdf",
        inlineText: "mixed",
        capturedAt: 2,
        userId: f.userId,
      }),
    );
    const damagedId = await f.t.run((ctx) =>
      ctx.db.insert("sourceRevisions", {
        spaceId: f.spaceId,
        sourceItemId: f.sourceItemId,
        contentHash: "c".repeat(64),
        byteLength: 7,
        mediaType: "text/plain",
        inlineText: "damaged",
        capturedAt: 3,
        userId: f.userId,
      }),
    );
    const otherSpaceId = await f.t.run((ctx) =>
      ctx.db.insert("spaces", {
        kind: "personal",
        name: "Other",
        createdBy: f.userId,
      }),
    );
    const brokenId = await f.t.run(async (ctx) =>
      ctx.db.insert("sourceRevisions", {
        spaceId: otherSpaceId,
        sourceItemId: f.sourceItemId,
        contentHash: await sha256Utf8("parent"),
        byteLength: 6,
        mediaType: "text/plain",
        inlineText: "parent",
        capturedAt: 4,
        userId: f.userId,
      }),
    );
    const result = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_revisions",
        cursor: null,
        maxItems: 4,
      }),
    );
    expect(result.invalidRows).toEqual(
      expect.arrayContaining([
        { rowId: mixedId, code: "invalid_representation" },
        { rowId: damagedId, code: "hash_mismatch" },
        { rowId: brokenId, code: "parent_mismatch" },
      ]),
    );
  });

  test("audits text hashes and exact revision parent chains", async () => {
    const f = await fixture();
    const revisionId = await insertLegacyRevision(f, "source");
    await f.t.run(async (ctx) =>
      ctx.db.insert("sourceTextVersions", {
        spaceId: f.spaceId,
        sourceRevisionId: revisionId,
        extractionFingerprint: "legacy:é",
        text: "retained😀",
        textHash: await sha256Utf8("retained😀"),
        byteLength: 12,
        evidenceSealed: false,
      }),
    );
    const invalidId = await f.t.run((ctx) =>
      ctx.db.insert("sourceTextVersions", {
        spaceId: f.spaceId,
        sourceRevisionId: revisionId,
        extractionFingerprint: "legacy:bad",
        text: "secret-value",
        textHash: "d".repeat(64),
        byteLength: 12,
        evidenceSealed: false,
      }),
    );
    const result = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_text_versions",
        cursor: null,
        maxItems: 4,
      }),
    );
    expect(result).toMatchObject({
      inspected: 2,
      validCount: 1,
      implicitLegacyCount: 1,
      invalidCount: 1,
      invalidRows: [{ rowId: invalidId, code: "hash_mismatch" }],
    });
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  test("does not accept a chain whose space was deleted", async () => {
    const f = await fixture();
    const revisionId = await insertLegacyRevision(f, "dangling-space");
    await f.t.run((ctx) => ctx.db.delete(f.spaceId));
    const result = await f.t.run((ctx) =>
      auditLegacyProvenancePage(ctx, {
        phase: "source_revisions",
        cursor: null,
        maxItems: 1,
      }),
    );
    expect(result.invalidRows).toEqual([
      { rowId: revisionId, code: "parent_mismatch" },
    ]);
  });

  test("rejects unbounded audit requests", async () => {
    const f = await fixture();
    await expect(
      f.t.run((ctx) =>
        auditLegacyProvenancePage(ctx, {
          phase: "source_revisions",
          cursor: null,
          maxItems: 5,
        }),
      ),
    ).rejects.toThrow("Invalid provenance audit page bounds");
  });
});
