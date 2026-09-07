import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  stageEvidenceSpans,
  stagePages,
} from "../provenance/model";
import {
  deleteGenerationRecordsBatch,
  deleteSourceItemRecordsBatch,
  hydrateObservation,
  stageRecordBatch,
  validateGenerationRecords,
} from "./model";
import type { StagedEventRecord } from "./validators";

async function seedBase() {
  const t = convexTest(schema, modules);
  const base = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const replacementUserId = await ctx.db.insert("users", {});
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic records",
      createdBy: userId,
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "manual",
      accountId: "synthetic-records",
      name: "Synthetic records",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:synthetic",
      kind: "person",
      canonicalName: "Synthetic Person",
      normalizedName: "synthetic person",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceItem = await createOrGetSourceItem(ctx, {
      spaceId,
      sourceAccountId,
      externalId: "source://synthetic/records",
    });
    return {
      userId,
      replacementUserId,
      spaceId,
      sourceAccountId,
      sourceItemId: sourceItem._id,
      entityId,
    };
  });
  return { t, ...base };
}

async function addGeneration(
  seeded: Awaited<ReturnType<typeof seedBase>>,
  suffix: string,
  text: string,
) {
  return await seeded.t.run(async (ctx) => {
    const revision = await createOrGetRevision(ctx, {
      spaceId: seeded.spaceId,
      sourceItemId: seeded.sourceItemId,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: 1_700_000_000_000 + suffix.length,
      userId: seeded.userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId: seeded.spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: `plain:${suffix}`,
      text,
    });
    const [page] = await stagePages(ctx, {
      spaceId: seeded.spaceId,
      sourceTextVersionId: textVersion._id,
      pages: [{ ordinal: 0, start: 0, end: text.length, text }],
    });
    const [evidence, valueEvidence] = await stageEvidenceSpans(ctx, {
      spaceId: seeded.spaceId,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      spans: [
        { sourcePageId: page!._id, ordinal: 0, start: 0, end: text.length },
        { sourcePageId: page!._id, ordinal: 1, start: 0, end: 1 },
      ],
    });
    const processingGenerationId = await ctx.db.insert(
      "processingGenerations",
      {
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        sourceItemId: seeded.sourceItemId,
        sourceRevisionId: revision._id,
        sourceTextVersionId: textVersion._id,
        processingFingerprint: `processing:${suffix}`,
        extractionFingerprint: `plain:${suffix}`,
        extractorFingerprint: "synthetic:v1",
        recordSchemaFingerprint: "records:v1",
        normalizationFingerprint: "exact:v1",
        chunkerFingerprint: "none:v1",
        correctionRevision: suffix,
        desiredProcessingEpoch: suffix.length,
        state: "processing",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 2,
        expectedDocumentCount: 0,
        expectedChunkCount: 0,
        expectedEventCount: 1,
        expectedObservationCount: 1,
        embeddingStatus: "unavailable",
      },
    );
    return {
      processingGenerationId,
      sourceRevisionId: revision._id,
      evidenceId: evidence!._id,
      valueEvidenceId: valueEvidence!._id,
    };
  });
}

function labRecord(
  seeded: Awaited<ReturnType<typeof seedBase>>,
  evidenceId: Awaited<ReturnType<typeof addGeneration>>["evidenceId"],
  value = "90",
): StagedEventRecord {
  return {
    eventKey: "lab-panel:stable",
    entityId: seeded.entityId,
    eventType: "lab_panel",
    schemaVersion: 1,
    occurrence: { precision: "date", date: "2026-01-10" },
    fieldEvidence: {
      occurrence: [evidenceId],
      entity: [evidenceId],
      eventType: [evidenceId],
    },
    observations: [
      {
        observationKey: "glucose",
        observationType: "glucose",
        value: { type: "decimal", value, unitCode: "mg/dL" },
        valueEvidence: [evidenceId],
      },
    ],
  };
}

describe("immutable typed records", () => {
  test("keeps stable event identity across revisions and reuses exact retries", async () => {
    const seeded = await seedBase();
    const first = await addGeneration(seeded, "one", "synthetic glucose 90");
    const record = labRecord(seeded, first.evidenceId, "090.00");
    const inserted = await seeded.t.run((ctx) =>
      stageRecordBatch(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: first.processingGenerationId,
        userId: seeded.userId,
        records: [record],
      }),
    );
    expect(inserted).toMatchObject({
      insertedEventCount: 1,
      insertedEventVersionCount: 1,
      insertedObservationCount: 1,
    });
    const retry = await seeded.t.run((ctx) =>
      stageRecordBatch(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: first.processingGenerationId,
        userId: seeded.replacementUserId,
        records: [record],
      }),
    );
    expect(retry).toMatchObject({
      insertedEventCount: 0,
      insertedEventVersionCount: 0,
      insertedObservationCount: 0,
    });
    expect(retry.eventIds).toEqual(inserted.eventIds);
    await expect(
      seeded.t.run((ctx) =>
        stageRecordBatch(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: first.processingGenerationId,
          userId: seeded.userId,
          records: [labRecord(seeded, first.evidenceId, "91")],
        }),
      ),
    ).rejects.toThrow("Conflicting immutable observation version");

    const correction = await addGeneration(
      seeded,
      "two",
      "synthetic corrected glucose 91",
    );
    const corrected = await seeded.t.run((ctx) =>
      stageRecordBatch(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: correction.processingGenerationId,
        userId: seeded.userId,
        records: [labRecord(seeded, correction.evidenceId, "91")],
      }),
    );
    expect(corrected.eventIds).toEqual(inserted.eventIds);
    expect(corrected.eventVersionIds).not.toEqual(inserted.eventVersionIds);
    expect(corrected.observationIds).not.toEqual(inserted.observationIds);
  });

  test("validates strict schemas, counts, and complete evidence parents", async () => {
    const seeded = await seedBase();
    const generation = await addGeneration(
      seeded,
      "validation",
      "synthetic glucose 90",
    );
    await seeded.t.run((ctx) =>
      stageRecordBatch(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: generation.processingGenerationId,
        userId: seeded.userId,
        records: [labRecord(seeded, generation.evidenceId)],
      }),
    );
    await expect(
      seeded.t.run((ctx) =>
        validateGenerationRecords(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generation.processingGenerationId,
          expectedEventCount: 0,
          expectedObservationCount: 0,
        }),
      ),
    ).rejects.toThrow("event count mismatch");
    await expect(
      seeded.t.run((ctx) =>
        stageRecordBatch(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generation.processingGenerationId,
          userId: seeded.userId,
          records: [
            {
              ...labRecord(seeded, generation.evidenceId),
              eventKey: "transaction",
              eventType: "financial_transaction",
            },
          ],
        }),
      ),
    ).rejects.toThrow("money values");
    const originalEvidence = await seeded.t.run((ctx) =>
      ctx.db.get(generation.evidenceId),
    );
    await seeded.t.run((ctx) =>
      ctx.db.patch(generation.evidenceId, { quoteHash: "0".repeat(64) }),
    );
    await expect(
      seeded.t.run((ctx) =>
        validateGenerationRecords(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generation.processingGenerationId,
          expectedEventCount: 1,
          expectedObservationCount: 1,
        }),
      ),
    ).rejects.toThrow("quote hash is invalid");
    await seeded.t.run(async (ctx) => {
      await ctx.db.patch(generation.evidenceId, {
        quoteHash: originalEvidence!.quoteHash,
      });
      await ctx.db.patch(originalEvidence!.sourcePageId, {
        text: "tampered page content",
      });
    });
    await expect(
      seeded.t.run((ctx) =>
        validateGenerationRecords(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generation.processingGenerationId,
          expectedEventCount: 1,
          expectedObservationCount: 1,
        }),
      ),
    ).rejects.toThrow("page text does not match");
  });

  test("rejects records whose validated evidence cannot be hydrated", async () => {
    const seeded = await seedBase();
    const generation = await addGeneration(
      seeded,
      "oversized-evidence",
      "x".repeat(16 * 1_024 + 1),
    );
    await expect(
      seeded.t.run((ctx) =>
        stageRecordBatch(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generation.processingGenerationId,
          userId: seeded.userId,
          records: [labRecord(seeded, generation.evidenceId)],
        }),
      ),
    ).rejects.toThrow("Hydrated record evidence exceeds the global limit");
    expect(
      await seeded.t.run((ctx) => ctx.db.query("events").first()),
    ).toBeNull();
  });

  test("hydrates only valid ready generations at current or snapshot visibility", async () => {
    const seeded = await seedBase();
    const generation = await addGeneration(
      seeded,
      "hydrate",
      "synthetic glucose 90",
    );
    const hydrationRecord = labRecord(seeded, generation.evidenceId);
    hydrationRecord.observations[0]!.valueEvidence = [
      generation.valueEvidenceId,
    ];
    const staged = await seeded.t.run((ctx) =>
      stageRecordBatch(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: generation.processingGenerationId,
        userId: seeded.userId,
        records: [hydrationRecord],
      }),
    );
    await expect(
      seeded.t.run((ctx) =>
        hydrateObservation(ctx, {
          spaceId: seeded.spaceId,
          observationId: staged.observationIds[0]!,
        }),
      ),
    ).rejects.toThrow("not ready");
    await seeded.t.run(async (ctx) => {
      await ctx.db.patch(generation.processingGenerationId, {
        state: "ready",
        activatedAt: 100,
      });
      await ctx.db.patch(seeded.sourceItemId, {
        activeRevisionId: generation.sourceRevisionId,
        activeGenerationId: generation.processingGenerationId,
      });
    });
    const current = await seeded.t.run((ctx) =>
      hydrateObservation(ctx, {
        spaceId: seeded.spaceId,
        observationId: staged.observationIds[0]!,
      }),
    );
    expect(current.observation.value).toMatchObject({ value: "90" });
    expect(current.evidence.map((item) => item.quote)).toEqual([
      "synthetic glucose 90",
      "s",
    ]);
    await expect(
      seeded.t.run((ctx) =>
        hydrateObservation(ctx, {
          spaceId: seeded.spaceId,
          observationId: staged.observationIds[0]!,
          snapshot: 99,
        }),
      ),
    ).rejects.toThrow("not active at the snapshot");
    expect(
      await seeded.t.run((ctx) =>
        hydrateObservation(ctx, {
          spaceId: seeded.spaceId,
          observationId: staged.observationIds[0]!,
          snapshot: 100,
        }),
      ),
    ).toMatchObject({ observation: { observationType: "glucose" } });
  });

  test("bounds cleanup and retains stable events until source forget", async () => {
    const seeded = await seedBase();
    const generation = await addGeneration(
      seeded,
      "cleanup",
      "synthetic glucose 90",
    );
    await seeded.t.run((ctx) =>
      stageRecordBatch(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: generation.processingGenerationId,
        userId: seeded.userId,
        records: [labRecord(seeded, generation.evidenceId)],
      }),
    );
    const first = await seeded.t.run((ctx) =>
      deleteGenerationRecordsBatch(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: generation.processingGenerationId,
        limit: 1,
      }),
    );
    expect(first).toEqual({ deleted: 1, done: false });
    const second = await seeded.t.run((ctx) =>
      deleteGenerationRecordsBatch(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: generation.processingGenerationId,
        limit: 1,
      }),
    );
    expect(second).toEqual({ deleted: 1, done: true });
    expect(
      await seeded.t.run((ctx) => ctx.db.query("events").first()),
    ).not.toBeNull();
    await expect(
      seeded.t.run((ctx) =>
        deleteSourceItemRecordsBatch(ctx, {
          spaceId: seeded.spaceId,
          sourceItemId: seeded.sourceItemId,
        }),
      ),
    ).rejects.toThrow("requires a forgetting source item");
    await seeded.t.run((ctx) =>
      ctx.db.patch(seeded.sourceItemId, { lifecycle: "forgetting" }),
    );
    expect(
      await seeded.t.run((ctx) =>
        deleteSourceItemRecordsBatch(ctx, {
          spaceId: seeded.spaceId,
          sourceItemId: seeded.sourceItemId,
          limit: 1,
        }),
      ),
    ).toMatchObject({ deleted: 1, deletedEvents: 1, done: true });
  });
});
