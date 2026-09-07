import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { upsertCoverageWindow } from "../coverage/model";
import {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  stageEvidenceSpans,
  stagePages,
} from "../provenance/model";
import { stageRecordBatch } from "./model";
import { executeRecordQuery, type RecordQueryResult } from "./query";
import {
  invalidateRecordQueriesForForget,
  nextRecordActivationTime,
  purgeRecordQuerySessionsForSpaceBatch,
} from "./querySessions";
import type { SumMoneyQuery } from "./queryValidators";
import type { StagedEventRecord } from "./validators";

const RANGE_FROM = Date.parse("2024-12-01T00:00:00Z");
const RANGE_TO = Date.parse("2026-01-01T00:00:00Z");
const ITEM_COUNT = 13;
const OBSERVATIONS_PER_ITEM = 20;
const TOTAL_OBSERVATIONS = ITEM_COUNT * OBSERVATIONS_PER_ITEM;

type ReadyItem = {
  sourceItemId: Id<"sourceItems">;
  sourceRevisionId: Id<"sourceRevisions">;
  processingGenerationId: Id<"processingGenerations">;
  observationIds: Id<"observations">[];
  occurrence: StagedEventRecord["occurrence"];
};

async function seedFinancialRecords() {
  const t = convexTest(schema, modules);
  const base = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic query integration",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", {
      spaceId,
      userId,
      role: "owner",
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "query-integration",
      name: "Synthetic query integration",
      enabled: true,
      cursorVersion: 1,
      freshnessMs: 1_000_000,
      createdBy: userId,
    });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:query-integration",
      kind: "person",
      canonicalName: "Synthetic Person",
      normalizedName: "synthetic person",
      aliases: [],
      normalizedAliases: [],
    });
    const keyOneId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "synthetic-query-key-one",
      keyPrefix: "syn_one",
      name: "Synthetic query key one",
      capabilities: ["read"],
      spaceIds: [spaceId],
    });
    const keyTwoId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "synthetic-query-key-two",
      keyPrefix: "syn_two",
      name: "Synthetic query key two",
      capabilities: ["read"],
      spaceIds: [spaceId],
    });
    return {
      userId,
      spaceId,
      sourceAccountId,
      entityId,
      keyOneId,
      keyTwoId,
    };
  });

  const items: ReadyItem[] = [];
  for (let itemIndex = 0; itemIndex < ITEM_COUNT; itemIndex += 1) {
    items.push(
      await t.run(async (ctx) => {
        const sourceItem = await createOrGetSourceItem(ctx, {
          spaceId: base.spaceId,
          sourceAccountId: base.sourceAccountId,
          externalId: `synthetic://transaction/${itemIndex}`,
        });
        const text = `synthetic transaction evidence ${itemIndex}`;
        const revision = await createOrGetRevision(ctx, {
          spaceId: base.spaceId,
          sourceItemId: sourceItem._id,
          mediaType: "text/plain",
          inlineText: text,
          capturedAt: 100 + itemIndex,
          userId: base.userId,
        });
        const textVersion = await createOrGetTextVersion(ctx, {
          spaceId: base.spaceId,
          sourceRevisionId: revision._id,
          extractionFingerprint: "query-integration:v1",
          text,
        });
        const [page] = await stagePages(ctx, {
          spaceId: base.spaceId,
          sourceTextVersionId: textVersion._id,
          pages: [{ ordinal: 0, start: 0, end: text.length, text }],
        });
        const [evidence] = await stageEvidenceSpans(ctx, {
          spaceId: base.spaceId,
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
            spaceId: base.spaceId,
            sourceAccountId: base.sourceAccountId,
            sourceItemId: sourceItem._id,
            sourceRevisionId: revision._id,
            sourceTextVersionId: textVersion._id,
            processingFingerprint: `query-integration:${itemIndex}:v1`,
            extractionFingerprint: "query-integration:v1",
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
            expectedEventCount: 1,
            expectedObservationCount: OBSERVATIONS_PER_ITEM,
            embeddingStatus: "unavailable",
          },
        );
        const occurrence = {
          precision: "datetime" as const,
          instant: Date.UTC(2025, 0, 1 + itemIndex),
          originalOffset: "Z",
        };
        const evidenceFields = {
          occurrence: [evidence!._id],
          entity: [evidence!._id],
          eventType: [evidence!._id],
        };
        const staged = await stageRecordBatch(ctx, {
          spaceId: base.spaceId,
          processingGenerationId,
          userId: base.userId,
          records: [
            {
              eventKey: "transaction",
              entityId: base.entityId,
              eventType: "financial_transaction",
              schemaVersion: 1,
              occurrence,
              fieldEvidence: evidenceFields,
              observations: Array.from(
                { length: OBSERVATIONS_PER_ITEM },
                (_, observationIndex) => ({
                  observationKey: `fee_${observationIndex.toString().padStart(2, "0")}`,
                  observationType: "fee",
                  value: {
                    type: "money" as const,
                    amount: "0.01",
                    currency: "USD",
                  },
                  valueEvidence: [evidence!._id],
                }),
              ),
            },
          ],
        });
        await ctx.db.patch(processingGenerationId, {
          state: "ready",
          activatedAt: 100,
        });
        await ctx.db.patch(sourceItem._id, {
          activeRevisionId: revision._id,
          activeGenerationId: processingGenerationId,
        });
        return {
          sourceItemId: sourceItem._id,
          sourceRevisionId: revision._id,
          processingGenerationId,
          observationIds: staged.observationIds,
          occurrence,
        };
      }),
    );
  }

  await t.run(async (ctx) => {
    await ctx.db.insert("spaceProcessingState", {
      spaceId: base.spaceId,
      activationEpoch: 1,
      activatedAt: 100,
    });
    await upsertCoverageWindow(ctx, {
      spaceId: base.spaceId,
      sourceAccountId: base.sourceAccountId,
      recordType: "fee",
      from: RANGE_FROM,
      to: RANGE_TO,
      state: "complete",
      lastEnumeratedAt: 900,
      lastProcessedAt: 900,
      discoveredCount: ITEM_COUNT,
      indexedCount: ITEM_COUNT,
      skippedCount: 0,
    });
  });
  return { t, ...base, items };
}

function accountSumQuery(
  seeded: Awaited<ReturnType<typeof seedFinancialRecords>>,
  overrides: Partial<SumMoneyQuery> = {},
): SumMoneyQuery {
  return {
    operation: "sum_money",
    spaceId: seeded.spaceId,
    sourceAccountId: seeded.sourceAccountId,
    lineItemType: "fee",
    from: RANGE_FROM,
    to: RANGE_TO,
    ...overrides,
  };
}

async function runSumToCompletion(
  seeded: Awaited<ReturnType<typeof seedFinancialRecords>>,
  query: SumMoneyQuery,
  startNow = 1_000,
) {
  let cursor: Id<"recordQuerySessions"> | undefined;
  let final: Extract<RecordQueryResult, { operation: "sum_money" }> | undefined;
  const contributionIds: Id<"observations">[] = [];
  for (let page = 0; page < 32; page += 1) {
    const result = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: { userId: seeded.userId },
        now: startNow + page,
        query: { ...query, ...(cursor ? { cursor } : {}) },
      }),
    );
    if (result.operation !== "sum_money") throw new Error("wrong result");
    final = result;
    contributionIds.push(...result.contributingObservationIds);
    cursor = result.cursor;
    if (!cursor) break;
  }
  if (!final || final.cursor) throw new Error("sum did not terminate");
  return { final, contributionIds };
}

async function activateCorrection(
  seeded: Awaited<ReturnType<typeof seedFinancialRecords>>,
  itemIndex: number,
  amount: string,
  now: number,
) {
  const item = seeded.items[itemIndex]!;
  const prepared = await seeded.t.run(async (ctx) => {
    const text = `synthetic corrected transaction ${itemIndex} ${amount}`;
    const revision = await createOrGetRevision(ctx, {
      spaceId: seeded.spaceId,
      sourceItemId: item.sourceItemId,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: now,
      userId: seeded.userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId: seeded.spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: `query-correction:${now}`,
      text,
    });
    const [page] = await stagePages(ctx, {
      spaceId: seeded.spaceId,
      sourceTextVersionId: textVersion._id,
      pages: [{ ordinal: 0, start: 0, end: text.length, text }],
    });
    const [evidence] = await stageEvidenceSpans(ctx, {
      spaceId: seeded.spaceId,
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
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        sourceItemId: item.sourceItemId,
        sourceRevisionId: revision._id,
        sourceTextVersionId: textVersion._id,
        processingFingerprint: `query-correction:${itemIndex}:${now}`,
        extractionFingerprint: `query-correction:${now}`,
        extractorFingerprint: "synthetic:v1",
        recordSchemaFingerprint: "records:v1",
        normalizationFingerprint: "exact:v1",
        chunkerFingerprint: "none:v1",
        correctionRevision: String(now),
        desiredProcessingEpoch: now,
        state: "processing",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 0,
        expectedChunkCount: 0,
        expectedEventCount: 1,
        expectedObservationCount: OBSERVATIONS_PER_ITEM,
        embeddingStatus: "unavailable",
      },
    );
    const evidenceFields = {
      occurrence: [evidence!._id],
      entity: [evidence!._id],
      eventType: [evidence!._id],
    };
    await stageRecordBatch(ctx, {
      spaceId: seeded.spaceId,
      processingGenerationId,
      userId: seeded.userId,
      records: [
        {
          eventKey: "transaction",
          entityId: seeded.entityId,
          eventType: "financial_transaction",
          schemaVersion: 1,
          occurrence: item.occurrence,
          fieldEvidence: evidenceFields,
          observations: Array.from(
            { length: OBSERVATIONS_PER_ITEM },
            (_, observationIndex) => ({
              observationKey: `fee_${observationIndex.toString().padStart(2, "0")}`,
              observationType: "fee",
              value: { type: "money", amount, currency: "USD" },
              valueEvidence: [evidence!._id],
            }),
          ),
        },
      ],
    });
    return { processingGenerationId, sourceRevisionId: revision._id };
  });
  return await seeded.t.run(async (ctx) => {
    const activatedAt = await nextRecordActivationTime(ctx, {
      spaceId: seeded.spaceId,
      now,
      previousActivatedAt: 100,
    });
    await ctx.db.patch(item.processingGenerationId, {
      deactivatedAt: activatedAt,
    });
    await ctx.db.patch(prepared.processingGenerationId, {
      state: "ready",
      activatedAt,
    });
    await ctx.db.patch(item.sourceItemId, {
      activeRevisionId: prepared.sourceRevisionId,
      activeGenerationId: prepared.processingGenerationId,
    });
    const state = await ctx.db
      .query("spaceProcessingState")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
      .unique();
    await ctx.db.patch(state!._id, {
      activationEpoch: state!.activationEpoch + 1,
      activatedAt,
    });
    item.processingGenerationId = prepared.processingGenerationId;
    item.sourceRevisionId = prepared.sourceRevisionId;
    return activatedAt;
  });
}

describe("exact query integration", () => {
  test("sums more than 256 rows exactly once by account and entity", async () => {
    const seeded = await seedFinancialRecords();
    const account = await runSumToCompletion(seeded, accountSumQuery(seeded));
    expect(account.final).toMatchObject({
      status: "total_complete",
      complete: true,
      totals: [{ currency: "USD", amount: "2.6" }],
    });
    expect(account.contributionIds).toHaveLength(TOTAL_OBSERVATIONS);
    expect(new Set(account.contributionIds).size).toBe(TOTAL_OBSERVATIONS);

    const entity = await runSumToCompletion(
      seeded,
      accountSumQuery(seeded, {
        sourceAccountId: undefined,
        sourceAccountIds: [seeded.sourceAccountId],
        entityId: seeded.entityId,
      }),
      1_100,
    );
    expect(entity.final.totals).toEqual([{ currency: "USD", amount: "2.6" }]);
    expect(entity.final.complete).toBe(true);
    expect(entity.contributionIds).toHaveLength(TOTAL_OBSERVATIONS);
    expect(new Set(entity.contributionIds).size).toBe(TOTAL_OBSERVATIONS);
  });

  test("snapshot resumes original versions while current mode invalidates", async () => {
    const seeded = await seedFinancialRecords();
    const baseQuery = accountSumQuery(seeded);
    const first = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: { userId: seeded.userId },
        now: 1_000,
        query: baseQuery,
      }),
    );
    if (first.operation !== "sum_money" || !first.cursor) {
      throw new Error("expected partial snapshot total");
    }
    await activateCorrection(seeded, 0, "1", 1_001);
    const snapshot = await runSumToCompletion(
      seeded,
      { ...baseQuery, cursor: first.cursor },
      1_002,
    );
    expect(snapshot.final.totals).toEqual([{ currency: "USD", amount: "2.6" }]);
    expect(snapshot.final.complete).toBe(true);

    const currentQuery = accountSumQuery(seeded, { consistency: "current" });
    const current = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: { userId: seeded.userId },
        now: 2_000,
        query: currentQuery,
      }),
    );
    if (current.operation !== "sum_money" || !current.cursor) {
      throw new Error("expected partial current total");
    }
    await activateCorrection(seeded, 1, "2", 2_001);
    await expect(
      seeded.t.run((ctx) =>
        executeRecordQuery(ctx, {
          principal: { userId: seeded.userId },
          now: 2_002,
          query: { ...currentQuery, cursor: current.cursor },
        }),
      ),
    ).rejects.toThrow("cursor is invalid");
  });

  test("binds cursors to credential and filter, then purges totals on forget", async () => {
    const seeded = await seedFinancialRecords();
    const query = accountSumQuery(seeded);
    const first = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: { userId: seeded.userId, credentialId: seeded.keyOneId },
        now: 1_000,
        query,
      }),
    );
    if (first.operation !== "sum_money" || !first.cursor) {
      throw new Error("expected partial total");
    }
    const stored = await seeded.t.run((ctx) => ctx.db.get(first.cursor!));
    expect(stored?.totals).toEqual(first.totals);
    expect(stored?.totals).not.toEqual([]);
    await expect(
      seeded.t.run((ctx) =>
        executeRecordQuery(ctx, {
          principal: { userId: seeded.userId, credentialId: seeded.keyOneId },
          now: 1_001,
          query: { ...query, from: RANGE_FROM + 1, cursor: first.cursor },
        }),
      ),
    ).rejects.toThrow("cursor is invalid");
    await expect(
      seeded.t.run((ctx) =>
        executeRecordQuery(ctx, {
          principal: { userId: seeded.userId, credentialId: seeded.keyTwoId },
          now: 1_001,
          query: { ...query, cursor: first.cursor },
        }),
      ),
    ).rejects.toThrow("cursor is invalid");

    await seeded.t.run(async (ctx) => {
      await invalidateRecordQueriesForForget(ctx, {
        spaceId: seeded.spaceId,
        now: 1_002,
      });
      await ctx.db.patch(seeded.items[0]!.sourceItemId, {
        lifecycle: "forgetting",
        activeRevisionId: undefined,
        activeGenerationId: undefined,
      });
    });
    await expect(
      seeded.t.run((ctx) =>
        executeRecordQuery(ctx, {
          principal: { userId: seeded.userId, credentialId: seeded.keyOneId },
          now: 1_003,
          query: { ...query, cursor: first.cursor },
        }),
      ),
    ).rejects.toThrow("cursor is invalid");
    await seeded.t.run((ctx) =>
      purgeRecordQuerySessionsForSpaceBatch(ctx, {
        spaceId: seeded.spaceId,
        limit: 64,
      }),
    );
    expect(await seeded.t.run((ctx) => ctx.db.get(first.cursor!))).toBeNull();
  });

  test("carries an earlier invalid row into an incomplete terminal total", async () => {
    const seeded = await seedFinancialRecords();
    const invalidId = seeded.items[0]!.observationIds[0]!;
    await seeded.t.run((ctx) =>
      ctx.db.patch(invalidId, {
        sourceRevisionId: seeded.items[1]!.sourceRevisionId,
      }),
    );
    const result = await runSumToCompletion(seeded, accountSumQuery(seeded));
    expect(result.final.totals).toEqual([{ currency: "USD", amount: "2.59" }]);
    expect(result.final.status).toBe("total_partial");
    expect(result.final.complete).toBe(false);
    expect(result.final.exclusions.invalid).toBeGreaterThanOrEqual(1);
    expect(result.contributionIds).toHaveLength(TOTAL_OBSERVATIONS - 1);
    expect(new Set(result.contributionIds).size).toBe(TOTAL_OBSERVATIONS - 1);
  });
});
