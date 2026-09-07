import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { webPrincipal } from "../../lib/spaces";
import { modules } from "../../test.setup";
import {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  stageEvidenceSpans,
  stagePages,
} from "../provenance/model";
import { stageRecordBatch } from "./model";
import { executeRecordQuery } from "./query";
import type { StagedEventRecord } from "./validators";

async function seedQueryableRecords() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic query space",
      createdBy: userId,
    });
    const membershipId = await ctx.db.insert("spaceMembers", {
      spaceId,
      userId,
      role: "owner",
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "exact-query",
      name: "Synthetic exact records",
      enabled: true,
      cursorVersion: 1,
      freshnessMs: 10_000,
      createdBy: userId,
    });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:query",
      kind: "person",
      canonicalName: "Synthetic Person",
      normalizedName: "synthetic person",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceItem = await createOrGetSourceItem(ctx, {
      spaceId,
      sourceAccountId,
      externalId: "synthetic://exact-query",
    });
    const text = "synthetic evidence for exact record queries";
    const revision = await createOrGetRevision(ctx, {
      spaceId,
      sourceItemId: sourceItem._id,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: 100,
      userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: "synthetic-query:v1",
      text,
    });
    const [page] = await stagePages(ctx, {
      spaceId,
      sourceTextVersionId: textVersion._id,
      pages: [{ ordinal: 0, start: 0, end: text.length, text }],
    });
    const [evidence] = await stageEvidenceSpans(ctx, {
      spaceId,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      spans: [
        {
          sourcePageId: page!._id,
          ordinal: 0,
          start: 0,
          end: text.length,
        },
      ],
    });
    const processingGenerationId = await ctx.db.insert(
      "processingGenerations",
      {
        spaceId,
        sourceAccountId,
        sourceItemId: sourceItem._id,
        sourceRevisionId: revision._id,
        sourceTextVersionId: textVersion._id,
        processingFingerprint: "synthetic-query:v1",
        extractionFingerprint: "synthetic-query:v1",
        extractorFingerprint: "synthetic:v1",
        recordSchemaFingerprint: "records:v1",
        normalizationFingerprint: "exact:v1",
        chunkerFingerprint: "none:v1",
        correctionRevision: "one",
        desiredProcessingEpoch: 1,
        state: "processing",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 0,
        expectedChunkCount: 0,
        expectedEventCount: 4,
        expectedObservationCount: 4,
        embeddingStatus: "unavailable",
      },
    );
    const evidenceId = evidence!._id;
    const evidenceFields = {
      occurrence: [evidenceId],
      entity: [evidenceId],
      eventType: [evidenceId],
    };
    const records: StagedEventRecord[] = [
      {
        eventKey: "lab:older",
        entityId,
        eventType: "lab_panel",
        schemaVersion: 1,
        occurrence: { precision: "date", date: "2025-01-10" },
        fieldEvidence: evidenceFields,
        observations: [
          {
            observationKey: "glucose",
            observationType: "glucose",
            value: { type: "decimal", value: "90", unitCode: "mg/dL" },
            valueEvidence: [evidenceId],
          },
        ],
      },
      {
        eventKey: "lab:newer",
        entityId,
        eventType: "lab_panel",
        schemaVersion: 1,
        occurrence: { precision: "date", date: "2025-02-10" },
        fieldEvidence: evidenceFields,
        observations: [
          {
            observationKey: "glucose",
            observationType: "glucose",
            value: { type: "decimal", value: "91", unitCode: "mg/dL" },
            valueEvidence: [evidenceId],
          },
        ],
      },
      {
        eventKey: "fee:usd",
        entityId,
        eventType: "financial_transaction",
        schemaVersion: 1,
        occurrence: {
          precision: "datetime",
          instant: Date.parse("2025-03-01T12:00:00Z"),
          originalOffset: "Z",
        },
        fieldEvidence: evidenceFields,
        observations: [
          {
            observationKey: "fee",
            observationType: "fee",
            value: { type: "money", amount: "0.10", currency: "USD" },
            valueEvidence: [evidenceId],
          },
        ],
      },
      {
        eventKey: "fee:cad",
        entityId,
        eventType: "financial_transaction",
        schemaVersion: 1,
        occurrence: {
          precision: "datetime",
          instant: Date.parse("2025-03-02T12:00:00Z"),
          originalOffset: "Z",
        },
        fieldEvidence: evidenceFields,
        observations: [
          {
            observationKey: "fee",
            observationType: "fee",
            value: { type: "money", amount: "2.30", currency: "CAD" },
            valueEvidence: [evidenceId],
          },
        ],
      },
    ];
    await stageRecordBatch(ctx, {
      spaceId,
      processingGenerationId,
      userId,
      records,
    });
    await ctx.db.patch(processingGenerationId, {
      state: "ready",
      activatedAt: 100,
    });
    await ctx.db.patch(sourceItem._id, {
      activeRevisionId: revision._id,
      activeGenerationId: processingGenerationId,
    });
    await ctx.db.insert("spaceProcessingState", {
      spaceId,
      activationEpoch: 1,
      activatedAt: 100,
    });
    for (const recordType of ["glucose", "fee"]) {
      await ctx.db.insert("coverageWindows", {
        spaceId,
        sourceAccountId,
        entityId,
        recordType,
        from: Date.parse("2025-01-01T00:00:00Z"),
        to: Date.parse("2026-01-01T00:00:00Z"),
        state: "complete",
        lastEnumeratedAt: 1_000,
        lastProcessedAt: 1_000,
        discoveredCount: 4,
        indexedCount: 4,
        skippedCount: 0,
      });
    }
    return {
      userId,
      spaceId,
      membershipId,
      sourceAccountId,
      entityId,
      processingGenerationId,
    };
  });
  return { t, ...seeded };
}

describe("exact record queries", () => {
  test("selects latest by occurrence and paginates history deterministically", async () => {
    const seeded = await seedQueryableRecords();
    const latest = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(seeded.userId),
        now: 1_001,
        query: {
          operation: "latest_observation",
          spaceId: seeded.spaceId,
          sourceAccountIds: [seeded.sourceAccountId],
          entityId: seeded.entityId,
          observationType: "glucose",
          asOf: Date.parse("2026-01-01T00:00:00Z"),
          unitCode: "mg/dL",
        },
      }),
    );
    expect(latest.operation).toBe("latest_observation");
    if (latest.operation !== "latest_observation")
      throw new Error("wrong result");
    expect(latest.candidates).toHaveLength(1);
    expect(latest.candidates[0]!.value).toMatchObject({ value: "91" });
    expect(latest.candidates[0]!.citations[0]).toMatchObject({
      quote: "synthetic evidence for exact record queries",
      fields: expect.arrayContaining(["occurrence", "observationValue"]),
    });

    const first = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(seeded.userId),
        now: 1_002,
        query: {
          operation: "observation_history",
          spaceId: seeded.spaceId,
          sourceAccountIds: [seeded.sourceAccountId],
          entityId: seeded.entityId,
          observationType: "glucose",
          from: Date.parse("2025-01-01T00:00:00Z"),
          to: Date.parse("2026-01-01T00:00:00Z"),
          order: "asc",
          limit: 1,
        },
      }),
    );
    if (first.operation !== "observation_history")
      throw new Error("wrong result");
    expect(first.records).toHaveLength(1);
    expect(first.cursor).toBeDefined();
    expect(first.complete).toBe(false);
    const second = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(seeded.userId),
        now: 1_003,
        query: {
          operation: "observation_history",
          spaceId: seeded.spaceId,
          sourceAccountIds: [seeded.sourceAccountId],
          entityId: seeded.entityId,
          observationType: "glucose",
          from: Date.parse("2025-01-01T00:00:00Z"),
          to: Date.parse("2026-01-01T00:00:00Z"),
          order: "asc",
          limit: 1,
          cursor: first.cursor,
        },
      }),
    );
    if (second.operation !== "observation_history")
      throw new Error("wrong result");
    expect(second.records).toHaveLength(1);
    expect(second.records[0]!.value).toMatchObject({ value: "91" });
    expect(second.cursor).toBeUndefined();
  });

  test("sums exact money by currency and qualifies coverage", async () => {
    const seeded = await seedQueryableRecords();
    const result = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(seeded.userId),
        now: 1_001,
        query: {
          operation: "sum_money",
          spaceId: seeded.spaceId,
          sourceAccountIds: [seeded.sourceAccountId],
          entityId: seeded.entityId,
          lineItemType: "fee",
          from: Date.parse("2025-01-01T00:00:00Z"),
          to: Date.parse("2026-01-01T00:00:00Z"),
        },
      }),
    );
    if (result.operation !== "sum_money") throw new Error("wrong result");
    expect(result.totals).toEqual([
      { currency: "CAD", amount: "2.3" },
      { currency: "USD", amount: "0.1" },
    ]);
    expect(result.contributions).toHaveLength(2);
    expect(result.contributingObservationIds).toHaveLength(2);
    expect(result.status).toBe("total_complete");
    expect(result.complete).toBe(true);
  });

  test("live membership revocation invalidates a resume cursor", async () => {
    const seeded = await seedQueryableRecords();
    const first = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(seeded.userId),
        now: 1_002,
        query: {
          operation: "observation_history",
          spaceId: seeded.spaceId,
          entityId: seeded.entityId,
          observationType: "glucose",
          from: Date.parse("2025-01-01T00:00:00Z"),
          to: Date.parse("2026-01-01T00:00:00Z"),
          order: "asc",
          limit: 1,
        },
      }),
    );
    if (first.operation !== "observation_history" || !first.cursor) {
      throw new Error("expected cursor");
    }
    await seeded.t.run((ctx) => ctx.db.delete(seeded.membershipId));
    await expect(
      seeded.t.run((ctx) =>
        executeRecordQuery(ctx, {
          principal: webPrincipal(seeded.userId),
          now: 1_003,
          query: {
            operation: "observation_history",
            spaceId: seeded.spaceId,
            entityId: seeded.entityId,
            observationType: "glucose",
            from: Date.parse("2025-01-01T00:00:00Z"),
            to: Date.parse("2026-01-01T00:00:00Z"),
            order: "asc",
            limit: 1,
            cursor: first.cursor,
          },
        }),
      ),
    ).rejects.toThrow("Space not found");
  });

  test("snapshot resumes survive corrections while current resumes invalidate", async () => {
    const seeded = await seedQueryableRecords();
    const start = async (consistency: "snapshot" | "current") =>
      await seeded.t.run((ctx) =>
        executeRecordQuery(ctx, {
          principal: webPrincipal(seeded.userId),
          now: 1_002,
          query: {
            operation: "observation_history",
            spaceId: seeded.spaceId,
            entityId: seeded.entityId,
            observationType: "glucose",
            from: Date.parse("2025-01-01T00:00:00Z"),
            to: Date.parse("2026-01-01T00:00:00Z"),
            order: "asc",
            limit: 1,
            consistency,
          },
        }),
      );
    const snapshot = await start("snapshot");
    const current = await start("current");
    if (
      snapshot.operation !== "observation_history" ||
      current.operation !== "observation_history" ||
      !snapshot.cursor ||
      !current.cursor
    ) {
      throw new Error("expected cursors");
    }
    await seeded.t.run(async (ctx) => {
      await ctx.db.patch(seeded.processingGenerationId, {
        deactivatedAt: 2_000,
      });
      const [state] = await ctx.db
        .query("spaceProcessingState")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .take(1);
      await ctx.db.patch(state!._id, {
        activationEpoch: 2,
        activatedAt: 2_000,
      });
      const windows = await ctx.db
        .query("coverageWindows")
        .withIndex("by_sourceAccountId", (q) =>
          q.eq("sourceAccountId", seeded.sourceAccountId),
        )
        .collect();
      for (const window of windows) {
        await ctx.db.patch(window._id, {
          lastEnumeratedAt: 1_500,
          lastProcessedAt: 1_500,
        });
      }
    });
    const resumed = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: webPrincipal(seeded.userId),
        now: 2_001,
        query: {
          operation: "observation_history",
          spaceId: seeded.spaceId,
          entityId: seeded.entityId,
          observationType: "glucose",
          from: Date.parse("2025-01-01T00:00:00Z"),
          to: Date.parse("2026-01-01T00:00:00Z"),
          order: "asc",
          limit: 1,
          consistency: "snapshot",
          cursor: snapshot.cursor,
        },
      }),
    );
    if (resumed.operation !== "observation_history")
      throw new Error("wrong result");
    expect(resumed.records).toHaveLength(1);
    expect(resumed.complete).toBe(false);
    expect(resumed.coverage.state).not.toBe("complete");
    await expect(
      seeded.t.run((ctx) =>
        executeRecordQuery(ctx, {
          principal: webPrincipal(seeded.userId),
          now: 2_001,
          query: {
            operation: "observation_history",
            spaceId: seeded.spaceId,
            entityId: seeded.entityId,
            observationType: "glucose",
            from: Date.parse("2025-01-01T00:00:00Z"),
            to: Date.parse("2026-01-01T00:00:00Z"),
            order: "asc",
            limit: 1,
            consistency: "current",
            cursor: current.cursor,
          },
        }),
      ),
    ).rejects.toThrow("cursor is invalid");
  });
});
