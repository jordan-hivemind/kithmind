import { v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { digestProcessingConfiguration } from "../ingestion/hash";
import { MAX_GENERATION_DOCUMENTS } from "../provenance/model";

import {
  cardEventKey,
  cardObservationKey,
  isCardRecordKind,
  requireCardEventSchema,
  type CardRecordKind,
} from "./cardSchemas";
import { probeFieldEvidence, stageRecordBatch } from "./model";
import { nextRecordActivationTime } from "./querySessions";
import { observationValueValidator } from "./valueValidators";
import type { ObservationValue } from "./values";
import type { CardDocTypePatch, StagedObservation } from "./validators";

const MAX_FINGERPRINT_PART_BYTES = 64;

/**
 * Section 4.6: the extraction fingerprint of a card generation. A change to
 * any part is a new generation, so a tier change is an audit trail rather
 * than a silent overwrite.
 */
export type CardExtractionFingerprint = {
  cardSchemaVersion: number;
  playbookVersion: string;
  promptVersion: string;
  gateVersion: string;
  tier: "local" | "tier0" | "tier1";
};

export type CardFieldInput = {
  /** The card field name, which is also the observation type. */
  field: string;
  /** Required for a repeated field, absent for a single-valued one. */
  ordinal?: number;
  value: ObservationValue;
  evidenceSpanIds: Id<"evidenceSpans">[];
};

export type PublishCardInput = {
  spaceId: Id<"spaces">;
  sourceItemId: Id<"sourceItems">;
  userId: Id<"users">;
  recordKind: CardRecordKind;
  now: number;
  fingerprint: CardExtractionFingerprint;
  /**
   * The span that identifies the document as this card. It carries the
   * event's own evidence, and a card whose anchor does not resolve publishes
   * nothing: an event with unprovable evidence is exactly what section 4.3
   * forbids.
   */
  anchorEvidenceSpanIds: Id<"evidenceSpans">[];
  /**
   * Section 4.5. Omitted for the kinds whose event entity is the source
   * account's configured subject entity.
   */
  entityId?: Id<"entities">;
  fields: CardFieldInput[];
};

export type PublishCardResult = {
  published: boolean;
  reason?:
    | "no_subject_entity"
    | "unresolvable_anchor"
    | "already_published"
    | "no_storable_field";
  processingGenerationId?: Id<"processingGenerations">;
  eventId?: Id<"events">;
  storedFields: string[];
  droppedFields: Array<{ key: string; reason: string }>;
};

function boundedPart(value: string, label: string): string {
  if (
    !value.trim() ||
    new TextEncoder().encode(value).length > MAX_FINGERPRINT_PART_BYTES
  ) {
    throw new Error(`${label} is empty or too long`);
  }
  return value;
}

/** Section 4.6: schema, playbook, prompt, gate and tier, in one string. */
export function cardExtractionFingerprint(
  recordKind: CardRecordKind,
  fingerprint: CardExtractionFingerprint,
): string {
  if (
    !Number.isSafeInteger(fingerprint.cardSchemaVersion) ||
    fingerprint.cardSchemaVersion < 1
  ) {
    throw new Error("Card schema version must be a positive integer");
  }
  return [
    "card-extraction-v1",
    recordKind,
    `schema:${fingerprint.cardSchemaVersion}`,
    `playbook:${boundedPart(fingerprint.playbookVersion, "Playbook version")}`,
    `prompt:${boundedPart(fingerprint.promptVersion, "Prompt version")}`,
    `gate:${boundedPart(fingerprint.gateVersion, "Gate version")}`,
    `tier:${fingerprint.tier}`,
  ].join("|");
}

async function setInventoryExclusionReason(
  ctx: MutationCtx,
  sourceItemId: Id<"sourceItems">,
  reason: "extraction_pending" | undefined,
): Promise<void> {
  const rows = await ctx.db
    .query("sourceInventory")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItemId))
    .take(8);
  for (const row of rows) {
    if (row.exclusionReason === reason) continue;
    // Only the card-owned reason is written here. A file excluded for any
    // other reason (unsupported, encrypted, duplicate_of, ...) keeps it:
    // those are review decisions, not extraction state.
    if (
      reason === undefined &&
      row.exclusionReason !== undefined &&
      row.exclusionReason !== "extraction_pending"
    ) {
      continue;
    }
    await ctx.db.patch(row._id, { exclusionReason: reason });
  }
}

function cardFieldKey(field: CardFieldInput): string {
  return cardObservationKey(field.field, field.ordinal);
}

/**
 * Publishes one card for one document as an event plus observations in the
 * existing record store, inside a processing generation that activates
 * atomically. See sections 4.1, 4.3, 4.5 and 4.6 of
 * docs/plans/2026-09-12-document-cards.md.
 *
 * No model runs here. The caller supplies an already-extracted card whose
 * fields cite spans; P2-70d supplies the gate that produces them and P2-70e
 * the ladder that runs it.
 */
export async function publishDocumentCard(
  ctx: MutationCtx,
  input: PublishCardInput,
): Promise<PublishCardResult> {
  if (!isCardRecordKind(input.recordKind)) {
    throw new Error("Unsupported card record kind");
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error("Card publication time is invalid");
  }
  const item = await ctx.db.get(input.sourceItemId);
  if (!item || item.spaceId !== input.spaceId) {
    throw new Error("Card document belongs to another space");
  }
  if (item.lifecycle !== "available") {
    throw new Error("Cards can only publish for an available source item");
  }
  const account = await ctx.db.get(item.sourceAccountId);
  if (!account || account.spaceId !== input.spaceId) {
    throw new Error("Card source account belongs to another space");
  }
  if (!item.activeGenerationId) {
    throw new Error("Card document has no active generation");
  }
  const base = await ctx.db.get(item.activeGenerationId);
  if (
    !base ||
    base.spaceId !== input.spaceId ||
    base.sourceItemId !== item._id ||
    base.state !== "ready" ||
    base.deactivatedAt !== undefined ||
    !base.sourceTextVersionId ||
    base.sourceRevisionId !== item.activeRevisionId
  ) {
    throw new Error("Card document has no readable retained text");
  }

  const entityId = input.entityId ?? account.subjectEntityId;
  if (!entityId) {
    // Section 4.5: a source with no configured subject entity publishes no
    // generic card, and its documents stay retained text with an
    // `extraction_pending` inventory reason.
    await setInventoryExclusionReason(ctx, item._id, "extraction_pending");
    return {
      published: false,
      reason: "no_subject_entity",
      storedFields: [],
      droppedFields: [],
    };
  }
  const entity = await ctx.db.get(entityId);
  if (!entity || entity.spaceId !== input.spaceId) {
    throw new Error("Card subject entity belongs to another space");
  }
  requireCardEventSchema(input.recordKind, entity);

  const recordSchemaFingerprint = cardExtractionFingerprint(
    input.recordKind,
    input.fingerprint,
  );
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: base.extractionFingerprint,
    extractorFingerprint: base.extractorFingerprint,
    recordSchemaFingerprint,
    normalizationFingerprint: base.normalizationFingerprint,
    chunkerFingerprint: base.chunkerFingerprint,
    correctionRevision: base.correctionRevision,
  });
  const existing = await ctx.db
    .query("processingGenerations")
    .withIndex("by_sourceRevisionId_and_processingFingerprint", (q) =>
      q
        .eq("sourceRevisionId", base.sourceRevisionId)
        .eq("processingFingerprint", processingFingerprint),
    )
    .take(2);
  if (existing.length > 1) {
    throw new Error("Duplicate card generation identity");
  }
  if (existing[0]) {
    // Exactly this card version was already published. Re-publishing it is a
    // retry, not a correction: change a fingerprint part to restate a card.
    return {
      published: false,
      reason: "already_published",
      processingGenerationId: existing[0]._id,
      storedFields: [],
      droppedFields: [],
    };
  }

  // Section 4.3: the evidence check is `requireEvidence`, reported per field.
  // Both the anchor and every field are proved against the sealed retained
  // text of the generation that holds it, before anything is written.
  const probe = await probeFieldEvidence(ctx, {
    spaceId: input.spaceId,
    processingGenerationId: base._id,
    fields: [
      { key: "", evidenceSpanIds: input.anchorEvidenceSpanIds },
      ...input.fields.map((field) => ({
        key: cardFieldKey(field),
        evidenceSpanIds: field.evidenceSpanIds,
      })),
    ],
  });
  const droppedFields = probe.dropped.filter((drop) => drop.key !== "");
  if (!probe.resolved.has("")) {
    await recordDrops(ctx, {
      spaceId: input.spaceId,
      sourceAccountId: account._id,
      sourceItemId: item._id,
      processingGenerationId: base._id,
      recordKind: input.recordKind,
      now: input.now,
      drops: probe.dropped.map((drop) => ({
        key: drop.key === "" ? "card_anchor" : drop.key,
        reason: drop.reason,
      })),
    });
    await setInventoryExclusionReason(ctx, item._id, "extraction_pending");
    return {
      published: false,
      reason: "unresolvable_anchor",
      storedFields: [],
      droppedFields,
    };
  }
  const storable = input.fields.filter((field) =>
    probe.resolved.has(cardFieldKey(field)),
  );
  if (storable.length === 0) {
    await recordDrops(ctx, {
      spaceId: input.spaceId,
      sourceAccountId: account._id,
      sourceItemId: item._id,
      processingGenerationId: base._id,
      recordKind: input.recordKind,
      now: input.now,
      drops: droppedFields,
    });
    await setInventoryExclusionReason(ctx, item._id, "extraction_pending");
    return {
      published: false,
      reason: "no_storable_field",
      storedFields: [],
      droppedFields,
    };
  }

  // The occurrence a date question answers is the card's own dated field,
  // bound to the span that asserts it. With no stored date the card is
  // undated: an unknown occurrence, never an invented one.
  const dateField = storable.find(
    (field) => field.value.type === "date" && field.ordinal === undefined,
  );
  const occurrence =
    dateField && dateField.value.type === "date"
      ? { precision: "date" as const, date: dateField.value.value }
      : { precision: "unknown" as const };

  const generationId = await ctx.db.insert("processingGenerations", {
    spaceId: input.spaceId,
    sourceAccountId: account._id,
    sourceItemId: item._id,
    sourceRevisionId: base.sourceRevisionId,
    sourceTextVersionId: base.sourceTextVersionId,
    processingFingerprint,
    // The retained text is reused exactly, so the text-extraction fingerprint
    // is unchanged and the generation shares the sealed text version, its
    // pages and its evidence spans. Only the record fingerprint moves.
    extractionFingerprint: base.extractionFingerprint,
    extractorFingerprint: base.extractorFingerprint,
    recordSchemaFingerprint,
    normalizationFingerprint: base.normalizationFingerprint,
    chunkerFingerprint: base.chunkerFingerprint,
    correctionRevision: base.correctionRevision,
    ...(base.parserArtifactId === undefined
      ? {}
      : { parserArtifactId: base.parserArtifactId }),
    ...(base.archiveSetDigest === undefined
      ? {}
      : { archiveSetDigest: base.archiveSetDigest }),
    ...(base.normalizedBundleDigest === undefined
      ? {}
      : { normalizedBundleDigest: base.normalizedBundleDigest }),
    ...(base.originalPrimaryReceiptId === undefined
      ? {}
      : { originalPrimaryReceiptId: base.originalPrimaryReceiptId }),
    ...(base.originalBackupReceiptId === undefined
      ? {}
      : { originalBackupReceiptId: base.originalBackupReceiptId }),
    ...(base.originalProviderReferenceId === undefined
      ? {}
      : { originalProviderReferenceId: base.originalProviderReferenceId }),
    ...(base.originalProviderBindingEpoch === undefined
      ? {}
      : { originalProviderBindingEpoch: base.originalProviderBindingEpoch }),
    ...(base.parserPrimaryReceiptId === undefined
      ? {}
      : { parserPrimaryReceiptId: base.parserPrimaryReceiptId }),
    ...(base.parserBackupReceiptId === undefined
      ? {}
      : { parserBackupReceiptId: base.parserBackupReceiptId }),
    desiredProcessingEpoch: item.desiredProcessingEpoch,
    cardGeneration: true,
    state: "processing",
    // A card generation is a sibling of the text generation, not a successor.
    // It carries no pages, evidence spans, documents or chunks of its own and
    // reads the text generation's sealed text version, so publishing a card
    // never changes a chunk id and never retires an embedding target.
    expectedPageCount: 0,
    expectedEvidenceSpanCount: 0,
    expectedDocumentCount: 0,
    expectedChunkCount: 0,
    expectedEventCount: 1,
    expectedObservationCount: storable.length,
    embeddingStatus: "unavailable",
  });

  const cardKindField = storable.find(
    (field) => field.field === "card_kind" && field.value.type === "text",
  );
  const docTypePatch =
    cardKindField && cardKindField.value.type === "text"
      ? await planDocTypePatch(ctx, {
          spaceId: input.spaceId,
          base,
          appliedDocType: cardKindField.value.value,
        })
      : [];

  const observations: StagedObservation[] = storable.map((field) => ({
    observationKey: cardFieldKey(field),
    observationType: field.field,
    value: field.value,
    valueEvidence: field.evidenceSpanIds,
  }));
  const staged = await stageRecordBatch(ctx, {
    spaceId: input.spaceId,
    processingGenerationId: generationId,
    userId: input.userId,
    records: [
      {
        eventKey: cardEventKey(input.recordKind),
        entityId: entity._id,
        eventType: input.recordKind,
        schemaVersion: 1,
        occurrence,
        fieldEvidence: {
          occurrence: dateField
            ? dateField.evidenceSpanIds
            : input.anchorEvidenceSpanIds,
          entity: input.anchorEvidenceSpanIds,
          eventType: input.anchorEvidenceSpanIds,
        },
        ...(docTypePatch.length === 0 ? {} : { docTypePatch }),
        observations,
      },
    ],
  });

  await ctx.db.patch(generationId, {
    actualPageCount: 0,
    actualEvidenceSpanCount: 0,
    actualDocumentCount: 0,
    actualChunkCount: 0,
    actualEventCount: 1,
    actualObservationCount: observations.length,
    state: "staged",
  });

  await activateCardGeneration(ctx, {
    spaceId: input.spaceId,
    item,
    processingGenerationId: generationId,
    now: input.now,
    docTypePatch,
  });

  await recordDrops(ctx, {
    spaceId: input.spaceId,
    sourceAccountId: account._id,
    sourceItemId: item._id,
    processingGenerationId: generationId,
    recordKind: input.recordKind,
    now: input.now,
    drops: droppedFields,
  });
  // Section 2.3: `extraction_pending` is the only reason expected to clear on
  // its own, and an accepted card is what clears it.
  await setInventoryExclusionReason(ctx, item._id, undefined);

  return {
    published: true,
    processingGenerationId: generationId,
    eventId: staged.eventIds[0]!,
    storedFields: observations.map((observation) => observation.observationKey),
    droppedFields,
  };
}

async function recordDrops(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    sourceItemId: Id<"sourceItems">;
    processingGenerationId: Id<"processingGenerations">;
    recordKind: CardRecordKind;
    now: number;
    drops: ReadonlyArray<{ key: string; reason: string }>;
  },
): Promise<void> {
  for (const drop of input.drops) {
    await ctx.db.insert("cardFieldDrops", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      sourceItemId: input.sourceItemId,
      processingGenerationId: input.processingGenerationId,
      recordKind: input.recordKind,
      fieldKey: drop.key.slice(0, 200),
      reason: drop.reason.slice(0, 500),
      createdAt: input.now,
    });
  }
}

/**
 * Section 4.2: the accepted `card_kind` becomes `documents.docType` so type
 * filtering and the card cannot disagree. A card generation carries no
 * documents of its own, so the patch lands on the active text generation's
 * rows in place. It is planned before staging and recorded on the card
 * version, which is what a rollback restores from, and it is idempotent: a
 * row already carrying the accepted value is left alone.
 */
async function planDocTypePatch(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    base: Doc<"processingGenerations">;
    appliedDocType: string;
  },
): Promise<CardDocTypePatch> {
  const documents = await ctx.db
    .query("documents")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", input.base._id),
    )
    .take(MAX_GENERATION_DOCUMENTS + 1);
  if (documents.length > MAX_GENERATION_DOCUMENTS) {
    throw new Error("Card document generation exceeds the document bound");
  }
  return documents
    .filter(
      (row) =>
        row.spaceId === input.spaceId &&
        row.publicationState === "active" &&
        row.docType !== input.appliedDocType,
    )
    .map((row) => ({
      documentId: row._id,
      ...(row.docType === undefined ? {} : { previousDocType: row.docType }),
      appliedDocType: input.appliedDocType,
    }));
}

/**
 * Atomic activation without a worker lease. The item keeps its active text
 * generation and gains an active card generation; the previous card
 * generation is retired so its versions stay snapshot readable. No document
 * row, chunk row, page or evidence span is created, moved or retired here,
 * which is what keeps chunk target ids stable across card publications.
 */
async function activateCardGeneration(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    item: Doc<"sourceItems">;
    processingGenerationId: Id<"processingGenerations">;
    now: number;
    docTypePatch: CardDocTypePatch;
  },
): Promise<number> {
  const states = await ctx.db
    .query("spaceProcessingState")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", input.spaceId))
    .take(2);
  if (states.length > 1)
    throw new Error("Space processing state is not unique");
  const prior = states[0];
  const activatedAt = await nextRecordActivationTime(ctx, {
    spaceId: input.spaceId,
    now: input.now,
    ...(prior?.activatedAt === undefined
      ? {}
      : { previousActivatedAt: prior.activatedAt }),
  });
  if (prior) {
    await ctx.db.patch(prior._id, {
      activationEpoch: prior.activationEpoch + 1,
      activatedAt,
    });
  } else {
    await ctx.db.insert("spaceProcessingState", {
      spaceId: input.spaceId,
      activationEpoch: 1,
      activatedAt,
    });
  }
  const previousCardGenerationId = input.item.activeCardGenerationId;
  if (
    previousCardGenerationId &&
    previousCardGenerationId !== input.processingGenerationId
  ) {
    const previous = await ctx.db.get(previousCardGenerationId);
    if (
      !previous ||
      previous.spaceId !== input.spaceId ||
      previous.sourceItemId !== input.item._id ||
      previous.cardGeneration !== true
    ) {
      throw new Error("Previous card generation is invalid");
    }
    await ctx.db.patch(previous._id, { deactivatedAt: activatedAt });
  }
  await ctx.db.patch(input.processingGenerationId, {
    state: "ready",
    activatedAt,
  });
  for (const patch of input.docTypePatch) {
    const document = await ctx.db.get(patch.documentId);
    if (
      !document ||
      document.spaceId !== input.spaceId ||
      document.publicationState !== "active"
    ) {
      throw new Error("Card docType target is no longer active");
    }
    await ctx.db.patch(patch.documentId, { docType: patch.appliedDocType });
  }
  // No embedding eligibility bump: the text generation, its documents and its
  // chunks are untouched, so every chunk target id and vector stays valid.
  await ctx.db.patch(input.item._id, {
    activeCardGenerationId: input.processingGenerationId,
  });
  return activatedAt;
}

const cardFieldValidator = v.object({
  field: v.string(),
  ordinal: v.optional(v.number()),
  value: observationValueValidator,
  evidenceSpanIds: v.array(v.id("evidenceSpans")),
});

/**
 * Section 4.5 and the migration commands of the plan. The expected current
 * value is required so a concurrent change cannot be overwritten.
 */
export const setSourceSubjectEntity = internalMutation({
  args: {
    sourceAccountId: v.id("sourceAccounts"),
    subjectEntityId: v.union(v.id("entities"), v.null()),
    expectedSubjectEntityId: v.union(v.id("entities"), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.sourceAccountId);
    if (!account) throw new Error("Source account does not exist");
    if ((account.subjectEntityId ?? null) !== args.expectedSubjectEntityId) {
      throw new Error("Source subject entity changed; reread and retry");
    }
    if (args.subjectEntityId !== null) {
      const entity = await ctx.db.get(args.subjectEntityId);
      if (!entity || entity.spaceId !== account.spaceId) {
        throw new Error("Subject entity belongs to another space");
      }
    }
    await ctx.db.patch(account._id, {
      subjectEntityId: args.subjectEntityId ?? undefined,
    });
    return null;
  },
});

/**
 * Trusted publication primitive. Worker lease authorization belongs to the
 * extraction runner of P2-70e; this function enforces the card record shape,
 * the evidence rule and the activation boundary.
 */
export const publishCard = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    sourceItemId: v.id("sourceItems"),
    userId: v.id("users"),
    recordKind: v.string(),
    now: v.number(),
    fingerprint: v.object({
      cardSchemaVersion: v.number(),
      playbookVersion: v.string(),
      promptVersion: v.string(),
      gateVersion: v.string(),
      tier: v.union(v.literal("local"), v.literal("tier0"), v.literal("tier1")),
    }),
    anchorEvidenceSpanIds: v.array(v.id("evidenceSpans")),
    entityId: v.optional(v.id("entities")),
    fields: v.array(cardFieldValidator),
  },
  handler: async (ctx, args) => {
    if (!isCardRecordKind(args.recordKind)) {
      throw new Error("Unsupported card record kind");
    }
    const { recordKind, entityId, ...rest } = args;
    return await publishDocumentCard(ctx, {
      ...rest,
      recordKind,
      ...(entityId === undefined ? {} : { entityId }),
    });
  },
});
