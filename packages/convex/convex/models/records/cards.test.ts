import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  stageEvidenceSpans,
  stagePages,
} from "../provenance/model";

import { sha256Hex } from "../ingestion/hash";
import { composeCardTargetInput } from "../embeddings/cardTargets";
import { publishDocumentCard, type CardFieldInput } from "./cards";
import {
  insertCardEmbedding,
  markEligibilityTargets,
  resolveAuthorizedCardVectorCandidates,
} from "../embeddings/model";
import {
  BASELINE_EMBEDDING_DIMENSIONS,
  fingerprintEmbeddingConfig,
} from "../../lib/embeddingProvider";
import { BASELINE_EMBEDDING_PROFILE } from "../embeddings/migrations";
import { stageRecordBatch } from "./model";
import { executeRecordQuery } from "./query";

// Synthetic fixture only. Nothing here describes a real document.
const TEXT = [
  "Mutual Non-Disclosure Agreement",
  "Dated 2025-03-04 between Northwind Supply and Acme Research.",
  "Summary: both sides keep the other side's material confidential.",
].join("\n");

const TITLE = "Mutual Non-Disclosure Agreement";
const DATE = "2025-03-04";
const PARTY_ONE = "Northwind Supply";
const PARTY_TWO = "Acme Research";
const SUMMARY = "both sides keep the other side's material confidential";
const CARD_KIND = "Non-Disclosure Agreement";

const FINGERPRINT = {
  cardSchemaVersion: 1,
  playbookVersion: "generic-1",
  promptVersion: "p1",
  tier: "tier0" as const,
};

function spanOf(quote: string): { start: number; end: number } {
  const start = TEXT.indexOf(quote);
  if (start < 0) throw new Error(`fixture quote missing: ${quote}`);
  return { start, end: start + quote.length };
}

async function seedDocument(options: { withSubjectEntity: boolean }) {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic cards",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:card-subject",
      kind: "person",
      canonicalName: "Synthetic Subject",
      normalizedName: "synthetic subject",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "synthetic-cards",
      name: "Synthetic cards",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 1_000_000,
      createdBy: userId,
      ...(options.withSubjectEntity ? { subjectEntityId: entityId } : {}),
    });
    const sourceItem = await createOrGetSourceItem(ctx, {
      spaceId,
      sourceAccountId,
      externalId: "synthetic://card/one",
    });
    const revision = await createOrGetRevision(ctx, {
      spaceId,
      sourceItemId: sourceItem._id,
      mediaType: "text/plain",
      inlineText: TEXT,
      capturedAt: 1_700_000_000_000,
      userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: "plain:v1",
      text: TEXT,
    });
    const [page] = await stagePages(ctx, {
      spaceId,
      sourceTextVersionId: textVersion._id,
      pages: [{ ordinal: 0, start: 0, end: TEXT.length, text: TEXT }],
    });
    const quotes = [TITLE, DATE, PARTY_ONE, PARTY_TWO, SUMMARY, CARD_KIND];
    const spans = await stageEvidenceSpans(ctx, {
      spaceId,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      spans: quotes
        .filter((quote) => TEXT.includes(quote))
        .map((quote, ordinal) => ({
          sourcePageId: page!._id,
          ordinal,
          ...spanOf(quote),
        })),
    });
    const present = quotes.filter((quote) => TEXT.includes(quote));
    const evidence = Object.fromEntries(
      present.map((quote, index) => [quote, spans[index]!._id]),
    ) as Record<string, Id<"evidenceSpans">>;

    const processingGenerationId = await ctx.db.insert(
      "processingGenerations",
      {
        spaceId,
        sourceAccountId,
        sourceItemId: sourceItem._id,
        sourceRevisionId: revision._id,
        sourceTextVersionId: textVersion._id,
        processingFingerprint: "cards-base:v1",
        extractionFingerprint: "plain:v1",
        extractorFingerprint: "synthetic:v1",
        recordSchemaFingerprint: "records:v1",
        normalizationFingerprint: "exact:v1",
        chunkerFingerprint: "none:v1",
        correctionRevision: "one",
        desiredProcessingEpoch: 1,
        state: "ready",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: spans.length,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
        expectedEventCount: 0,
        expectedObservationCount: 0,
        actualPageCount: 1,
        actualEvidenceSpanCount: spans.length,
        actualDocumentCount: 1,
        actualChunkCount: 1,
        embeddingStatus: "unavailable",
        activatedAt: 100,
      },
    );
    const documentId = await ctx.db.insert("documents", {
      spaceId,
      processingGenerationId,
      sourceItemId: sourceItem._id,
      sourceRevisionId: revision._id,
      sourceTextVersionId: textVersion._id,
      documentKey: "synthetic://card/one",
      title: "Worker supplied title",
      docType: "note",
      capturedAt: 1_700_000_000_000,
      evidenceSpanIds: [spans[0]!._id],
      publicationState: "active",
    });
    await ctx.db.insert("chunks", {
      spaceId,
      processingGenerationId,
      documentId,
      ordinal: 0,
      sourceTextVersionId: textVersion._id,
      start: 0,
      end: TEXT.length,
      text: TEXT,
      evidenceSpanIds: [spans[0]!._id],
      publicationState: "active",
    });
    await ctx.db.patch(textVersion._id, { evidenceSealed: true });
    await ctx.db.patch(sourceItem._id, {
      desiredRevisionId: revision._id,
      activeRevisionId: revision._id,
      activeGenerationId: processingGenerationId,
    });
    await ctx.db.insert("spaceProcessingState", {
      spaceId,
      activationEpoch: 1,
      activatedAt: 100,
    });
    const apiKeyId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "synthetic-card-key",
      keyPrefix: "syn_card",
      name: "Synthetic card key",
      capabilities: ["read"],
      spaceIds: [spaceId],
    });
    const scanId = await ctx.db.insert("workerSourceScans", {
      spaceId,
      sourceAccountId,
      requestId: "synthetic-scan",
      requestDigest: "synthetic-scan-digest",
      watcherId: "synthetic-watcher",
      connectorVersion: "synthetic:v1",
      mode: "normal",
      inventoryEpoch: 1,
      manifestVersionAtBegin: 1,
      actorUserId: userId,
      actorCredentialId: apiKeyId,
      state: "enumerated",
      nextPageOrdinal: 1,
      inventoryDone: true,
      pageCount: 1,
      entryCount: 1,
      changedCount: 0,
      gapCount: 0,
      reviewCount: 0,
      nextReconcileOrdinal: 0,
      startedAt: 1,
      expiresAt: 2,
      retireAt: 3,
    });
    await ctx.db.insert("sourceInventory", {
      spaceId,
      sourceAccountId,
      sourceItemId: sourceItem._id,
      identityKeyHash: "synthetic-card-identity",
      relativePath: "agreements/nda.txt",
      folderPath: "agreements",
      fileName: "nda.txt",
      modifiedAt: 1_700_000_000_000,
      contentIndexed: true,
      exclusionReason: "extraction_pending",
      firstSeenScanId: scanId,
      lastSeenScanId: scanId,
    });
    return {
      userId,
      spaceId,
      sourceAccountId,
      sourceItemId: sourceItem._id,
      entityId,
      documentId,
      processingGenerationId,
      evidence,
    };
  });
  return { t, ...seeded };
}

function genericFields(
  evidence: Record<string, Id<"evidenceSpans">>,
  overrides: { partyOneEvidence?: Id<"evidenceSpans">[] } = {},
): CardFieldInput[] {
  return [
    {
      field: "card_kind",
      value: { type: "text", value: CARD_KIND },
      evidenceSpanIds: [evidence[CARD_KIND]!],
    },
    {
      field: "card_title",
      value: { type: "text", value: TITLE },
      evidenceSpanIds: [evidence[TITLE]!],
    },
    {
      field: "card_date",
      value: { type: "date", value: DATE },
      evidenceSpanIds: [evidence[DATE]!],
    },
    {
      field: "card_party",
      ordinal: 0,
      value: { type: "text", value: PARTY_ONE },
      evidenceSpanIds: overrides.partyOneEvidence ?? [evidence[PARTY_ONE]!],
    },
    {
      field: "card_party",
      ordinal: 1,
      value: { type: "text", value: PARTY_TWO },
      evidenceSpanIds: [evidence[PARTY_TWO]!],
    },
    {
      field: "card_summary",
      value: { type: "text", value: SUMMARY },
      evidenceSpanIds: [evidence[SUMMARY]!],
    },
  ];
}

/** Replaces one field's proposed value, leaving its cited span alone. */
function withValue(
  fields: CardFieldInput[],
  name: string,
  value: CardFieldInput["value"],
): CardFieldInput[] {
  return fields.map((field) =>
    field.field === name ? { ...field, value } : field,
  );
}

describe("document cards", () => {
  test("publishes a generic card that query_records answers by date and entity", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    expect(published.published).toBe(true);
    expect(published.droppedFields).toEqual([]);
    expect(published.storedFields.sort()).toEqual([
      "card_date",
      "card_kind",
      "card_party:0",
      "card_party:1",
      "card_summary",
      "card_title",
    ]);

    const events = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: { userId: seeded.userId },
        now: 2_000,
        query: {
          operation: "list_events",
          spaceId: seeded.spaceId,
          entityId: seeded.entityId,
          eventType: "document_card",
          from: Date.parse("2025-01-01T00:00:00Z"),
          to: Date.parse("2026-01-01T00:00:00Z"),
          order: "asc",
        },
      }),
    );
    if (events.operation !== "list_events") throw new Error("wrong operation");
    expect(events.records).toHaveLength(1);
    expect(events.records[0]!.occurrence).toEqual({
      precision: "date",
      date: DATE,
    });

    const parties = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: { userId: seeded.userId },
        now: 2_100,
        query: {
          operation: "observation_history",
          spaceId: seeded.spaceId,
          entityId: seeded.entityId,
          observationType: "card_party",
          from: Date.parse("2025-01-01T00:00:00Z"),
          to: Date.parse("2026-01-01T00:00:00Z"),
          order: "asc",
        },
      }),
    );
    if (parties.operation !== "observation_history") {
      throw new Error("wrong operation");
    }
    expect(
      parties.records
        .map((row) =>
          row.value.type === "text" ? row.value.value : row.value.type,
        )
        .sort(),
    ).toEqual([PARTY_TWO, PARTY_ONE].sort());
    // Every returned field carries its evidence quote.
    expect(parties.records.every((row) => row.citations.length > 0)).toBe(true);

    // Dates outside the card's own date do not match it.
    const empty = await seeded.t.run((ctx) =>
      executeRecordQuery(ctx, {
        principal: { userId: seeded.userId },
        now: 2_200,
        query: {
          operation: "list_events",
          spaceId: seeded.spaceId,
          entityId: seeded.entityId,
          eventType: "document_card",
          from: Date.parse("2026-01-01T00:00:00Z"),
          to: Date.parse("2027-01-01T00:00:00Z"),
          order: "asc",
        },
      }),
    );
    if (empty.operation !== "list_events") throw new Error("wrong operation");
    expect(empty.records).toHaveLength(0);

    // Section 4.2: activation patches the active document row's docType in
    // place, so type filtering and the accepted card kind cannot disagree,
    // and the previous value is recorded on the card version.
    const state = await seeded.t.run(async (ctx) => ({
      document: (await ctx.db.get(seeded.documentId))!,
      version: (
        await ctx.db
          .query("eventVersions")
          .withIndex("by_eventId", (q) => q.eq("eventId", published.eventId!))
          .collect()
      )[0]!,
    }));
    expect(state.document.docType).toBe(CARD_KIND);
    expect(state.document.publicationState).toBe("active");
    expect(state.version.docTypePatch).toEqual([
      {
        documentId: seeded.documentId,
        previousDocType: "note",
        appliedDocType: CARD_KIND,
      },
    ]);
  });

  test("drops a field whose span does not resolve and records the drop", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    const strangerSpanId = await seeded.t.run(async (ctx) => {
      // A span over a different text version never resolves in this document.
      const revision = await createOrGetRevision(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        mediaType: "text/plain",
        inlineText: "unrelated retained text",
        capturedAt: 1_700_000_000_001,
        userId: seeded.userId,
      });
      const textVersion = await createOrGetTextVersion(ctx, {
        spaceId: seeded.spaceId,
        sourceRevisionId: revision._id,
        extractionFingerprint: "plain:other",
        text: "unrelated retained text",
      });
      const [page] = await stagePages(ctx, {
        spaceId: seeded.spaceId,
        sourceTextVersionId: textVersion._id,
        pages: [
          { ordinal: 0, start: 0, end: 23, text: "unrelated retained text" },
        ],
      });
      const [span] = await stageEvidenceSpans(ctx, {
        spaceId: seeded.spaceId,
        sourceRevisionId: revision._id,
        sourceTextVersionId: textVersion._id,
        spans: [{ sourcePageId: page!._id, ordinal: 0, start: 0, end: 9 }],
      });
      return span!._id;
    });

    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence, {
          partyOneEvidence: [strangerSpanId],
        }),
      }),
    );
    expect(published.published).toBe(true);
    expect(published.storedFields).not.toContain("card_party:0");
    expect(published.storedFields).toContain("card_party:1");
    expect(published.droppedFields.map((drop) => drop.key)).toEqual([
      "card_party:0",
    ]);

    const drops = await seeded.t.run((ctx) =>
      ctx.db
        .query("cardFieldDrops")
        .withIndex("by_sourceItemId", (q) =>
          q.eq("sourceItemId", seeded.sourceItemId),
        )
        .collect(),
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      fieldKey: "card_party:0",
      recordKind: "document_card",
    });

    const stored = await seeded.t.run((ctx) =>
      ctx.db
        .query("observations")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", published.processingGenerationId!),
        )
        .collect(),
    );
    expect(stored.map((row) => row.observationKey).sort()).toEqual([
      "card_date",
      "card_kind",
      "card_party:1",
      "card_summary",
      "card_title",
    ]);
  });

  test("publishes nothing and marks extraction_pending without a subject entity", async () => {
    const seeded = await seedDocument({ withSubjectEntity: false });
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    expect(published).toMatchObject({
      published: false,
      reason: "no_subject_entity",
    });
    const after = await seeded.t.run(async (ctx) => ({
      events: await ctx.db.query("events").collect(),
      generations: await ctx.db.query("processingGenerations").collect(),
      inventory: await ctx.db.query("sourceInventory").collect(),
    }));
    expect(after.events).toHaveLength(0);
    expect(after.generations).toHaveLength(1);
    expect(after.inventory[0]!.exclusionReason).toBe("extraction_pending");
  });

  test("re-publication stages a new generation and the old one stays readable", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    const first = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    expect(first.published).toBe(true);

    // The same fingerprint is a retry, not a correction.
    const retry = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_100,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    expect(retry).toMatchObject({
      published: false,
      reason: "already_published",
      processingGenerationId: first.processingGenerationId,
    });

    // A tier change is a new fingerprint, so a new generation.
    const second = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_200,
        fingerprint: { ...FINGERPRINT, tier: "tier1" },
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    expect(second.published).toBe(true);
    expect(second.processingGenerationId).not.toBe(
      first.processingGenerationId,
    );
    // One stable event identity across both card versions.
    expect(second.eventId).toBe(first.eventId);

    const state = await seeded.t.run(async (ctx) => {
      const item = (await ctx.db.get(seeded.sourceItemId))!;
      const old = (await ctx.db.get(first.processingGenerationId!))!;
      const current = (await ctx.db.get(second.processingGenerationId!))!;
      const versions = await ctx.db
        .query("eventVersions")
        .withIndex("by_eventId", (q) => q.eq("eventId", first.eventId!))
        .collect();
      const document = (await ctx.db.get(seeded.documentId))!;
      return { item, old, current, versions, document };
    });
    // The text generation is still the active text generation, and the card
    // generation is a sibling rather than its successor.
    expect(state.item.activeGenerationId).toBe(seeded.processingGenerationId);
    expect(state.item.activeCardGenerationId).toBe(
      second.processingGenerationId,
    );
    expect(state.old.state).toBe("ready");
    expect(state.old.deactivatedAt).toBeGreaterThan(state.old.activatedAt!);
    expect(state.current.deactivatedAt).toBeUndefined();
    // Old card versions stay addressable.
    expect(state.versions).toHaveLength(2);
    // The document row is patched in place, never retired or duplicated.
    expect(state.document.publicationState).toBe("active");
    expect(state.document.docType).toBe(CARD_KIND);
  });

  test("two card publications leave chunk ids and embedding targets untouched", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    const before = await seeded.t.run(async (ctx) => {
      const chunks = await ctx.db.query("chunks").collect();
      await ctx.db.insert("embeddingTargets", {
        spaceId: seeded.spaceId,
        targetKind: "chunk",
        targetId: String(chunks[0]!._id),
        inputHash: "synthetic-chunk-hash",
        processingGenerationId: seeded.processingGenerationId,
        state: "eligible",
        updatedAt: 10,
      });
      return {
        chunks: await ctx.db.query("chunks").collect(),
        documents: await ctx.db.query("documents").collect(),
        targets: await ctx.db.query("embeddingTargets").collect(),
      };
    });

    for (const [index, tier] of (["tier0", "tier1"] as const).entries()) {
      const published = await seeded.t.run((ctx) =>
        publishDocumentCard(ctx, {
          spaceId: seeded.spaceId,
          sourceItemId: seeded.sourceItemId,
          userId: seeded.userId,
          recordKind: "document_card",
          now: 1_000 + index,
          fingerprint: { ...FINGERPRINT, tier },
          anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
          fields: genericFields(seeded.evidence),
        }),
      );
      expect(published.published).toBe(true);
    }

    const after = await seeded.t.run(async (ctx) => ({
      chunks: await ctx.db.query("chunks").collect(),
      documents: await ctx.db.query("documents").collect(),
      targets: await ctx.db.query("embeddingTargets").collect(),
    }));
    // I3 and I11 of the index capacity plan: unchanged content keeps its
    // target identity, so a card publication forces no re-embed.
    expect(after.chunks.map((row) => row._id)).toEqual(
      before.chunks.map((row) => row._id),
    );
    expect(after.chunks.map((row) => row.publicationState)).toEqual(
      before.chunks.map((row) => row.publicationState),
    );
    expect(after.documents.map((row) => row._id)).toEqual(
      before.documents.map((row) => row._id),
    );
    expect(after.targets).toEqual(before.targets);
  });

  test("refuses a card record in a pipeline generation", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    await seeded.t.run((ctx) =>
      ctx.db.patch(seeded.processingGenerationId, { state: "processing" }),
    );
    await expect(
      seeded.t.run((ctx) =>
        stageRecordBatch(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: seeded.processingGenerationId,
          userId: seeded.userId,
          records: [
            {
              eventKey: "card:document_card",
              entityId: seeded.entityId,
              eventType: "document_card",
              schemaVersion: 1,
              occurrence: { precision: "unknown" },
              fieldEvidence: {
                occurrence: [seeded.evidence[TITLE]!],
                entity: [seeded.evidence[TITLE]!],
                eventType: [seeded.evidence[TITLE]!],
              },
              observations: [],
            },
          ],
        }),
      ),
    ).rejects.toThrow("Card records require a card processing generation");
  });

  test("refuses a card for a document in another space", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    const otherSpaceId = await seeded.t.run(async (ctx) =>
      ctx.db.insert("spaces", {
        kind: "personal",
        name: "Other space",
        createdBy: seeded.userId,
      }),
    );
    await expect(
      seeded.t.run((ctx) =>
        publishDocumentCard(ctx, {
          spaceId: otherSpaceId,
          sourceItemId: seeded.sourceItemId,
          userId: seeded.userId,
          recordKind: "document_card",
          now: 1_000,
          fingerprint: FINGERPRINT,
          anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
          fields: genericFields(seeded.evidence),
        }),
      ),
    ).rejects.toThrow("another space");
  });

  test("refuses a field that is not in the card kind's schema", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    // The gate now refuses this before staging can throw, which is the
    // section 5.2 shape: a runner proposing a field the kind does not declare
    // fails the gate with a closed code rather than crashing the publication.
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: [
          {
            field: "principal_amount",
            value: { type: "money", amount: "1.00", currency: "USD" },
            evidenceSpanIds: [seeded.evidence[TITLE]!],
          },
        ],
      }),
    );
    expect(published.published).toBe(false);
    expect(published.reason).toBe("gate_failed");
    expect(published.gateFailures).toContainEqual({
      key: "principal_amount",
      code: "field_not_declared",
    });
  });

  test("a required field the gate refuses stages nothing at that tier", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        // The value is not what the cited span says. No model is consulted.
        fields: withValue(genericFields(seeded.evidence), "card_title", {
          type: "text",
          value: "Master Services Agreement",
        }),
      }),
    );
    expect(published.published).toBe(false);
    expect(published.reason).toBe("gate_failed");
    expect(published.requiredFieldFailed).toBe(true);
    expect(published.gateFailures).toEqual([
      { key: "card_title", code: "value_not_in_span" },
    ]);

    const state = await seeded.t.run(async (ctx) => ({
      cardGenerations: (
        await ctx.db.query("processingGenerations").collect()
      ).filter((row) => row.cardGeneration === true),
      observations: await ctx.db.query("observations").collect(),
      events: await ctx.db.query("events").collect(),
      drops: await ctx.db.query("cardFieldDrops").collect(),
      attempts: await ctx.db.query("cardExtractionAttempts").collect(),
      item: (await ctx.db.get(seeded.sourceItemId))!,
    }));
    // Nothing staged, nothing activated, and the document stays pending.
    expect(state.cardGenerations).toEqual([]);
    expect(state.observations).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.item.activeCardGenerationId).toBeUndefined();
    // Below the top step the ladder escalates, so no review item is raised
    // yet and the next attempt's row is the one that would carry it.
    expect(state.drops).toEqual([]);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({
      step: "tier0",
      outcome: "escalated",
      passedFieldCount: 0,
      droppedFieldCount: 0,
      failedFieldCount: 1,
      failureCodes: ["value_not_in_span"],
    });
  });

  test("a required failure at the top step is a card_gate_failed review item", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: { ...FINGERPRINT, tier: "tier1" },
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: withValue(genericFields(seeded.evidence), "card_title", {
          type: "text",
          value: "Master Services Agreement",
        }),
      }),
    );
    expect(published.published).toBe(false);

    const state = await seeded.t.run(async (ctx) => ({
      drops: await ctx.db.query("cardFieldDrops").collect(),
      attempts: await ctx.db.query("cardExtractionAttempts").collect(),
    }));
    expect(state.drops).toHaveLength(1);
    expect(state.drops[0]).toMatchObject({
      kind: "card_gate_failed",
      fieldKey: "card_title",
      code: "value_not_in_span",
    });
    expect(state.attempts[0]).toMatchObject({
      step: "tier1",
      outcome: "review",
    });
  });

  test("an optional field the gate refuses drops alone and is counted", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: withValue(genericFields(seeded.evidence), "card_date", {
          type: "date",
          value: "2025-03-05",
        }),
      }),
    );
    expect(published.published).toBe(true);
    expect(published.requiredFieldFailed).toBe(false);
    expect(published.droppedFields).toEqual([
      { key: "card_date", code: "value_not_in_span" },
    ]);
    expect(published.storedFields).not.toContain("card_date");

    const state = await seeded.t.run(async (ctx) => ({
      drops: await ctx.db.query("cardFieldDrops").collect(),
      attempts: await ctx.db.query("cardExtractionAttempts").collect(),
    }));
    expect(state.drops).toHaveLength(1);
    expect(state.drops[0]).toMatchObject({
      kind: "field_dropped",
      fieldKey: "card_date",
      code: "value_not_in_span",
    });
    expect(state.attempts[0]).toMatchObject({
      outcome: "accepted",
      passedFieldCount: 5,
      droppedFieldCount: 1,
      failedFieldCount: 1,
      failureCodes: ["value_not_in_span"],
    });
    // Section 5.4: counts and closed codes only. No value, no span text, no
    // field text of any kind reaches the attempt row.
    expect(Object.keys(state.attempts[0]!).sort()).toEqual([
      "_creationTime",
      "_id",
      "cardSchemaVersion",
      "createdAt",
      "droppedFieldCount",
      "failedFieldCount",
      "failureCodes",
      "gateVersion",
      "outcome",
      "passedFieldCount",
      "playbookVersion",
      "promptVersion",
      "recordKind",
      "sourceAccountId",
      "sourceItemId",
      "spaceId",
      "step",
    ]);
  });
});

/**
 * P2-6ab seeds the counters; a space that has never run the backfill keeps
 * the legacy derive, so a card target only appears on a counted space.
 */
async function enableTargetCounters(seeded: Awaited<ReturnType<typeof seedDocument>>) {
  await seeded.t.run(async (ctx) => {
    const existing = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
      .unique();
    const fields = {
      eligibleCounts: { thought: 0, chunk: 0, card: 0 },
      counterDrift: false,
      lastAuditAt: 1,
      targetPolicy: "cards_and_opted_in_chunks" as const,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return;
    }
    await ctx.db.insert("spaceEmbeddingStates", {
      spaceId: seeded.spaceId,
      eligibilityEpoch: 1,
      ...fields,
    });
  });
}

async function cardTargets(seeded: Awaited<ReturnType<typeof seedDocument>>) {
  return await seeded.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("embeddingTargets")
      .withIndex("by_space_kind_target", (q) =>
        q.eq("spaceId", seeded.spaceId).eq("targetKind", "card"),
      )
      .collect();
    const state = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
      .unique();
    return { rows, eligibleCounts: state?.eligibleCounts };
  });
}

describe("card embedding targets", () => {
  test("activation creates one card target and a supersession keeps its vector", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    await enableTargetCounters(seeded);

    const first = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    expect(first.published).toBe(true);

    const afterFirst = await cardTargets(seeded);
    // Exactly one target per document, keyed by the card event.
    expect(afterFirst.rows).toHaveLength(1);
    expect(afterFirst.rows[0]!.targetId).toBe(String(first.eventId));
    expect(afterFirst.rows[0]!.state).toBe("eligible");
    // The row carries no processing generation: that is what lets a new card
    // generation over unchanged text keep the vector (I3).
    expect(afterFirst.rows[0]!.processingGenerationId).toBeUndefined();
    expect(afterFirst.eligibleCounts).toEqual({
      thought: 0,
      chunk: 0,
      card: 1,
    });
    // The composed input is the plan's section 8.1 field list, in order.
    const composed = await seeded.t.run((ctx) =>
      composeCardTargetInput(ctx, seeded.spaceId, seeded.sourceItemId),
    );
    expect(composed!.text).toBe(
      [
        `Kind: ${CARD_KIND}`,
        `Title: ${TITLE}`,
        `Date: ${DATE}`,
        `Parties: ${PARTY_ONE}, ${PARTY_TWO}`,
        `Summary: ${SUMMARY}`,
      ].join("\n"),
    );
    expect(composed!.summary).toBe(SUMMARY);
    expect(afterFirst.rows[0]!.inputHash).toBe(await sha256Hex(composed!.text));

    // A tier change supersedes the card generation. Same text, same card
    // event, so the same target row with the same hash survives.
    const second = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_200,
        fingerprint: { ...FINGERPRINT, tier: "tier1" },
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    expect(second.published).toBe(true);
    const afterSecond = await cardTargets(seeded);
    expect(afterSecond.rows).toHaveLength(1);
    expect(afterSecond.rows[0]!._id).toBe(afterFirst.rows[0]!._id);
    expect(afterSecond.rows[0]!.inputHash).toBe(afterFirst.rows[0]!.inputHash);
    expect(afterSecond.eligibleCounts).toEqual({
      thought: 0,
      chunk: 0,
      card: 1,
    });
  });

  test("a changed summary moves the hash and drops the coverage marker", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    await enableTargetCounters(seeded);
    await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    const before = await cardTargets(seeded);
    await seeded.t.run((ctx) =>
      ctx.db.patch(before.rows[0]!._id, {
        coveredFingerprint: "synthetic-fingerprint",
      }),
    );
    await seeded.t.run(async (ctx) => {
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        coveredCounts: [
          {
            fingerprint: "synthetic-fingerprint",
            counts: { thought: 0, chunk: 0, card: 1 },
          },
        ],
      });
    });

    // Republishing without the summary changes the composed input.
    const changed = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_400,
        fingerprint: { ...FINGERPRINT, tier: "tier1" },
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence).filter(
          (field) => field.field !== "card_summary",
        ),
      }),
    );
    expect(changed.published).toBe(true);
    const after = await cardTargets(seeded);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.inputHash).not.toBe(before.rows[0]!.inputHash);
    expect(after.rows[0]!.coveredFingerprint).toBeUndefined();
    expect(after.eligibleCounts).toEqual({ thought: 0, chunk: 0, card: 1 });
  });

  test("hydration drops a card vector whose card generation has moved on (I7)", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    await enableTargetCounters(seeded);
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    const fingerprint = await fingerprintEmbeddingConfig(
      BASELINE_EMBEDDING_PROFILE,
    );
    const vector = Array.from(
      { length: BASELINE_EMBEDDING_DIMENSIONS },
      (_, index) => (index % 5) + 1,
    );
    const { vectorId, principal } = await seeded.t.run(async (ctx) => {
      const profileId = await ctx.db.insert("embeddingProfiles", {
        fingerprint,
        ...BASELINE_EMBEDDING_PROFILE,
        createdAt: 1,
      });
      const generationId = await ctx.db.insert("embeddingGenerations", {
        spaceId: seeded.spaceId,
        embeddingProfileId: profileId,
        fingerprint,
        state: "active",
        eligibilityEpoch: 1,
        manifestHash: "synthetic-manifest",
        expectedThoughtCount: 0,
        expectedChunkCount: 0,
        completedThoughtCount: 0,
        completedChunkCount: 0,
        createdAt: 1,
        activatedAt: 2,
      });
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        activeEmbeddingGenerationId: generationId,
        activeFingerprint: fingerprint,
        activatedAt: 2,
      });
      const composed = await composeCardTargetInput(
        ctx,
        seeded.spaceId,
        seeded.sourceItemId,
      );
      const id = await insertCardEmbedding(ctx, {
        spaceId: seeded.spaceId,
        eventId: published.eventId!,
        embeddingGenerationId: generationId,
        fingerprint,
        inputText: composed!.text,
        vector,
        bumpEligibility: false,
      });
      return {
        vectorId: id,
        principal: { userId: seeded.userId },
      };
    });

    const hits = await seeded.t.run((ctx) =>
      resolveAuthorizedCardVectorCandidates(ctx, {
        principal,
        targets: [{ spaceId: seeded.spaceId, fingerprint }],
        embeddingVectorIds: [vectorId],
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      eventId: published.eventId,
      spaceId: seeded.spaceId,
      summary: SUMMARY,
      documentIds: [seeded.documentId],
    });

    // A new card generation with a different summary moves the composed hash.
    // The stored vector now describes text the card no longer has, so I7
    // drops it rather than returning it.
    const restated = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_500,
        fingerprint: { ...FINGERPRINT, tier: "tier1" },
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence).filter(
          (field) => field.field !== "card_summary",
        ),
      }),
    );
    expect(restated.published).toBe(true);
    expect(
      await seeded.t.run((ctx) =>
        resolveAuthorizedCardVectorCandidates(ctx, {
          principal,
          targets: [{ spaceId: seeded.spaceId, fingerprint }],
          embeddingVectorIds: [vectorId],
        }),
      ),
    ).toHaveLength(0);
  });

  test("a card candidate from an unauthorized space is never returned", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    await enableTargetCounters(seeded);
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    const fingerprint = await fingerprintEmbeddingConfig(
      BASELINE_EMBEDDING_PROFILE,
    );
    const vector = Array.from(
      { length: BASELINE_EMBEDDING_DIMENSIONS },
      (_, index) => (index % 5) + 1,
    );
    const { vectorId, outsiderId } = await seeded.t.run(async (ctx) => {
      const profileId = await ctx.db.insert("embeddingProfiles", {
        fingerprint,
        ...BASELINE_EMBEDDING_PROFILE,
        createdAt: 1,
      });
      const generationId = await ctx.db.insert("embeddingGenerations", {
        spaceId: seeded.spaceId,
        embeddingProfileId: profileId,
        fingerprint,
        state: "active",
        eligibilityEpoch: 1,
        manifestHash: "synthetic-manifest",
        expectedThoughtCount: 0,
        expectedChunkCount: 0,
        completedThoughtCount: 0,
        completedChunkCount: 0,
        createdAt: 1,
        activatedAt: 2,
      });
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        activeEmbeddingGenerationId: generationId,
        activeFingerprint: fingerprint,
        activatedAt: 2,
      });
      const composed = await composeCardTargetInput(
        ctx,
        seeded.spaceId,
        seeded.sourceItemId,
      );
      const id = await insertCardEmbedding(ctx, {
        spaceId: seeded.spaceId,
        eventId: published.eventId!,
        embeddingGenerationId: generationId,
        fingerprint,
        inputText: composed!.text,
        vector,
        bumpEligibility: false,
      });
      const outsider = await ctx.db.insert("users", { name: "Outsider" });
      return { vectorId: id, outsiderId: outsider };
    });

    // Space isolation fails closed: an unauthorized principal never reaches
    // the card row, and the read is refused rather than silently emptied.
    await expect(
      seeded.t.run((ctx) =>
        resolveAuthorizedCardVectorCandidates(ctx, {
          principal: { userId: outsiderId },
          targets: [{ spaceId: seeded.spaceId, fingerprint }],
          embeddingVectorIds: [vectorId],
        }),
      ),
    ).rejects.toThrow();

    // And a card row that does reach hydration under a principal with no
    // authorized target is dropped, not returned.
    expect(
      await seeded.t.run((ctx) =>
        resolveAuthorizedCardVectorCandidates(ctx, {
          principal: { userId: outsiderId },
          targets: [],
          embeddingVectorIds: [vectorId],
        }),
      ),
    ).toHaveLength(0);
  });

  test("abandoning the card generation retires the card target", async () => {
    const seeded = await seedDocument({ withSubjectEntity: true });
    await enableTargetCounters(seeded);
    const published = await seeded.t.run((ctx) =>
      publishDocumentCard(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.sourceItemId,
        userId: seeded.userId,
        recordKind: "document_card",
        now: 1_000,
        fingerprint: FINGERPRINT,
        anchorEvidenceSpanIds: [seeded.evidence[TITLE]!],
        fields: genericFields(seeded.evidence),
      }),
    );
    expect(published.published).toBe(true);
    expect((await cardTargets(seeded)).eligibleCounts).toEqual({
      thought: 0,
      chunk: 0,
      card: 1,
    });

    // An operator or a failure abandons the generation. The next eligibility
    // write finds no live card and retires the target.
    await seeded.t.run(async (ctx) => {
      await ctx.db.patch(seeded.sourceItemId, {
        activeCardGenerationId: undefined,
      });
      await markEligibilityTargets(ctx, seeded.spaceId, {
        sourceItemIds: [seeded.sourceItemId],
      });
    });
    const after = await cardTargets(seeded);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.state).toBe("retired");
    expect(after.eligibleCounts).toEqual({ thought: 0, chunk: 0, card: 0 });
    expect(
      await seeded.t.run((ctx) =>
        composeCardTargetInput(ctx, seeded.spaceId, seeded.sourceItemId),
      ),
    ).toBeNull();
  });
});
