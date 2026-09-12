import { v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { digestProcessingConfiguration } from "../ingestion/hash";
import {
  MAX_GENERATION_DOCUMENTS,
  stageCardEvidenceSpans,
  sweepCardEvidenceSpans,
  type CardEvidenceRef,
} from "../provenance/model";

import {
  CARD_GATE_VERSION,
  gateCard,
  type CardGateFailureCode,
  type CardGateReport,
} from "./cardGate";
import { CARD_PRICE_TABLE_VERSION } from "./cardRunner";
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
  /**
   * Section 5.4: what the runner that produced this candidate cost. Omitted
   * by a caller that ran no runner, such as a trusted fixture publication.
   */
  runner?: CardRunnerMeasurement;
};

/** Counts, a model id and a price. Never a value and never document text. */
export type CardRunnerMeasurement = {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  wallTimeMs: number;
};

export type PublishCardResult = {
  published: boolean;
  reason?:
    | "no_subject_entity"
    | "unresolvable_anchor"
    | "already_published"
    | "gate_failed"
    | "no_storable_field";
  processingGenerationId?: Id<"processingGenerations">;
  eventId?: Id<"events">;
  storedFields: string[];
  /** Optional fields the gate refused. The card published without them. */
  droppedFields: Array<{ key: string; code: CardGateFailureCode }>;
  /**
   * Every gate failure, required ones included. Section 5.2 leaves the
   * escalation decision to the ladder of P2-70e, so the failure is returned
   * rather than retried here.
   */
  gateFailures: Array<{ key: string; code: CardGateFailureCode }>;
  /** True when a required field failed, so nothing was staged at this tier. */
  requiredFieldFailed: boolean;
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
    // The gate version is not the caller's to assert. It is the version of
    // the code that just proved the card, so a normalizer change is a new
    // generation rather than a silent revaluation of a stored one.
    `gate:${CARD_GATE_VERSION}`,
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
 * No model runs here, and none is consulted about whether the card is right.
 * The caller supplies an already-extracted card whose fields cite spans, and
 * the mechanical gate of section 5.2 runs before anything is staged: a
 * required-field failure stages nothing at this tier and is returned to the
 * caller, and an optional-field failure drops that field alone. The ladder
 * that reads the returned failure and decides to escalate is P2-70e.
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
      gateFailures: [],
      requiredFieldFailed: false,
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
      gateFailures: [],
      requiredFieldFailed: false,
    };
  }

  // Rule 1 of section 5.2, which is also the section 4.3 evidence check:
  // every cited span must resolve in the sealed retained text of the
  // generation that holds it and recompute to its stored `quoteHash`. The
  // anchor and every field are proved before anything is written, and the
  // proved span text is what the normalizers then read.
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
  const evidenceCodes = new Map(
    probe.dropped.map((drop) => [drop.key, drop.code]),
  );
  const evidenceReasons = new Map(
    probe.dropped.map((drop) => [drop.key, drop.reason]),
  );
  const topTier = input.fingerprint.tier === "tier1";
  const drop = (key: string, code: CardGateFailureCode) => ({
    key,
    code,
    reason: evidenceReasons.get(key) ?? code,
  });

  if (!probe.resolved.has("")) {
    // The event's own evidence is required by nature: an event whose anchor
    // cannot be proved publishes nothing at all.
    const failures = probe.dropped.map((entry) => ({
      key: entry.key === "" ? "card_anchor" : entry.key,
      code: entry.code as CardGateFailureCode,
    }));
    await recordAttempt(ctx, {
      spaceId: input.spaceId,
      sourceAccountId: account._id,
      sourceItemId: item._id,
      recordKind: input.recordKind,
      fingerprint: input.fingerprint,
      now: input.now,
      ...(input.runner ? { runner: input.runner } : {}),
      outcome: topTier ? "review" : "escalated",
      passedFieldCount: 0,
      droppedFieldCount: 0,
      failures,
    });
    await recordDrops(ctx, {
      spaceId: input.spaceId,
      sourceAccountId: account._id,
      sourceItemId: item._id,
      processingGenerationId: base._id,
      recordKind: input.recordKind,
      now: input.now,
      kind: topTier ? "card_gate_failed" : "field_dropped",
      drops: probe.dropped.map((entry) =>
        drop(entry.key === "" ? "card_anchor" : entry.key, entry.code),
      ),
    });
    await setInventoryExclusionReason(ctx, item._id, "extraction_pending");
    return {
      published: false,
      reason: "unresolvable_anchor",
      storedFields: [],
      droppedFields: [],
      gateFailures: failures,
      requiredFieldFailed: true,
    };
  }

  // Rules 2 to 7, in pure code with no model in the loop.
  const gate: CardGateReport = gateCard({
    recordKind: input.recordKind,
    fields: input.fields.map((field) => {
      const key = cardFieldKey(field);
      const evidenceFailure = evidenceCodes.get(key);
      return {
        field: field.field,
        ...(field.ordinal === undefined ? {} : { ordinal: field.ordinal }),
        value: field.value,
        spanTexts: probe.quotes.get(key) ?? [],
        ...(evidenceFailure === undefined ? {} : { evidenceFailure }),
      };
    }),
  });

  if (gate.requiredFailed) {
    // Section 5.2 outcomes: nothing is staged from this tier, and the failure
    // goes back to the caller. At the top automatic step it is also a
    // `card_gate_failed` review item; below it the ladder escalates and a
    // drop row here would only duplicate the next attempt's.
    await recordAttempt(ctx, {
      spaceId: input.spaceId,
      sourceAccountId: account._id,
      sourceItemId: item._id,
      recordKind: input.recordKind,
      fingerprint: input.fingerprint,
      now: input.now,
      ...(input.runner ? { runner: input.runner } : {}),
      outcome: topTier ? "review" : "escalated",
      passedFieldCount: 0,
      droppedFieldCount: 0,
      failures: gate.failed,
    });
    if (topTier) {
      await recordDrops(ctx, {
        spaceId: input.spaceId,
        sourceAccountId: account._id,
        sourceItemId: item._id,
        processingGenerationId: base._id,
        recordKind: input.recordKind,
        now: input.now,
        kind: "card_gate_failed",
        drops: gate.failed.map((failure) => drop(failure.key, failure.code)),
      });
    }
    await setInventoryExclusionReason(ctx, item._id, "extraction_pending");
    return {
      published: false,
      reason: "gate_failed",
      storedFields: [],
      droppedFields: [],
      gateFailures: gate.failed,
      requiredFieldFailed: true,
    };
  }

  const droppedFields = gate.dropped;
  const passedKeys = new Set(gate.passedKeys);
  const storable = input.fields.filter((field) =>
    passedKeys.has(cardFieldKey(field)),
  );
  if (storable.length === 0) {
    await recordAttempt(ctx, {
      spaceId: input.spaceId,
      sourceAccountId: account._id,
      sourceItemId: item._id,
      recordKind: input.recordKind,
      fingerprint: input.fingerprint,
      now: input.now,
      ...(input.runner ? { runner: input.runner } : {}),
      outcome: topTier ? "review" : "escalated",
      passedFieldCount: 0,
      droppedFieldCount: 0,
      failures: gate.failed,
    });
    await recordDrops(ctx, {
      spaceId: input.spaceId,
      sourceAccountId: account._id,
      sourceItemId: item._id,
      processingGenerationId: base._id,
      recordKind: input.recordKind,
      now: input.now,
      kind: topTier ? "card_gate_failed" : "field_dropped",
      drops: droppedFields.map((failure) => drop(failure.key, failure.code)),
    });
    await setInventoryExclusionReason(ctx, item._id, "extraction_pending");
    return {
      published: false,
      reason: "no_storable_field",
      storedFields: [],
      droppedFields,
      gateFailures: gate.failed,
      requiredFieldFailed: false,
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

  await recordAttempt(ctx, {
    spaceId: input.spaceId,
    sourceAccountId: account._id,
    sourceItemId: item._id,
    recordKind: input.recordKind,
    fingerprint: input.fingerprint,
    now: input.now,
    ...(input.runner ? { runner: input.runner } : {}),
    outcome: "accepted",
    passedFieldCount: observations.length,
    droppedFieldCount: droppedFields.length,
    failures: gate.failed,
  });
  await recordDrops(ctx, {
    spaceId: input.spaceId,
    sourceAccountId: account._id,
    sourceItemId: item._id,
    processingGenerationId: generationId,
    recordKind: input.recordKind,
    now: input.now,
    kind: "field_dropped",
    drops: droppedFields.map((failure) => drop(failure.key, failure.code)),
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
    gateFailures: gate.failed,
    requiredFieldFailed: false,
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
    kind: "field_dropped" | "card_gate_failed";
    drops: ReadonlyArray<{ key: string; code: string; reason: string }>;
  },
): Promise<void> {
  for (const dropped of input.drops) {
    await ctx.db.insert("cardFieldDrops", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      sourceItemId: input.sourceItemId,
      processingGenerationId: input.processingGenerationId,
      recordKind: input.recordKind,
      kind: input.kind,
      fieldKey: dropped.key.slice(0, 200),
      code: dropped.code.slice(0, 64),
      reason: dropped.reason.slice(0, 500),
      createdAt: input.now,
    });
  }
}

/**
 * Section 5.4: one row per gate run, per document and tier. Counts and closed
 * codes only. No field value and no span text is written here, so the cost
 * and ladder report can never become a second copy of the document.
 */
async function recordAttempt(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    sourceItemId: Id<"sourceItems">;
    recordKind: CardRecordKind;
    fingerprint: CardExtractionFingerprint;
    now: number;
    runner?: CardRunnerMeasurement;
    outcome: "accepted" | "escalated" | "review" | "skipped";
    passedFieldCount: number;
    droppedFieldCount: number;
    failures: ReadonlyArray<{ key: string; code: string }>;
  },
): Promise<void> {
  await ctx.db.insert("cardExtractionAttempts", {
    spaceId: input.spaceId,
    sourceAccountId: input.sourceAccountId,
    sourceItemId: input.sourceItemId,
    recordKind: input.recordKind,
    step: input.fingerprint.tier,
    gateVersion: CARD_GATE_VERSION,
    promptVersion: input.fingerprint.promptVersion,
    playbookVersion: input.fingerprint.playbookVersion,
    cardSchemaVersion: input.fingerprint.cardSchemaVersion,
    outcome: input.outcome,
    passedFieldCount: input.passedFieldCount,
    droppedFieldCount: input.droppedFieldCount,
    failedFieldCount: input.failures.length,
    failureCodes: [
      ...new Set(input.failures.map((failure) => failure.code)),
    ].sort(),
    ...(input.runner
      ? {
          modelId: input.runner.modelId,
          priceTableVersion: CARD_PRICE_TABLE_VERSION,
          inputTokens: input.runner.inputTokens,
          outputTokens: input.runner.outputTokens,
          costMicroUsd: input.runner.costMicroUsd,
          wallTimeMs: input.runner.wallTimeMs,
        }
      : {}),
    createdAt: input.now,
  });
}

/**
 * Section 5.1: a ladder step that could not run. The row exists so the step
 * is visible in the cost and ladder report and so it is never mistaken for a
 * step that ran and passed. It stages nothing and refuses nothing.
 */
export const recordSkippedCardAttempt = internalMutation({
  args: {
    sourceItemId: v.id("sourceItems"),
    recordKind: v.string(),
    step: v.union(v.literal("local"), v.literal("tier0"), v.literal("tier1")),
    modelId: v.string(),
    fingerprint: v.object({
      cardSchemaVersion: v.number(),
      playbookVersion: v.string(),
      promptVersion: v.string(),
      tier: v.union(v.literal("local"), v.literal("tier0"), v.literal("tier1")),
    }),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isCardRecordKind(args.recordKind)) {
      throw new Error("Unsupported card record kind");
    }
    const item = await ctx.db.get(args.sourceItemId);
    if (!item) throw new Error("Card document does not exist");
    await ctx.db.insert("cardExtractionAttempts", {
      spaceId: item.spaceId,
      sourceAccountId: item.sourceAccountId,
      sourceItemId: item._id,
      recordKind: args.recordKind,
      step: args.step,
      gateVersion: CARD_GATE_VERSION,
      promptVersion: args.fingerprint.promptVersion,
      playbookVersion: args.fingerprint.playbookVersion,
      cardSchemaVersion: args.fingerprint.cardSchemaVersion,
      outcome: "skipped",
      passedFieldCount: 0,
      droppedFieldCount: 0,
      failedFieldCount: 0,
      failureCodes: [],
      modelId: args.modelId,
      priceTableVersion: CARD_PRICE_TABLE_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
      wallTimeMs: 0,
      createdAt: args.now,
    });
    return null;
  },
});

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
 * One cited location. Exactly one of `quote` or the `start`/`end` pair is
 * meaningful; a row carrying neither resolves to no span, which is the same
 * outcome as a location the page does not contain.
 */
const cardEvidenceRefValidator = v.object({
  pageOrdinal: v.number(),
  start: v.optional(v.number()),
  end: v.optional(v.number()),
  quote: v.optional(v.string()),
});

function toCardEvidenceRef(ref: {
  pageOrdinal: number;
  start?: number;
  end?: number;
  quote?: string;
}): CardEvidenceRef {
  return ref.quote !== undefined
    ? { pageOrdinal: ref.pageOrdinal, quote: ref.quote }
    : {
        pageOrdinal: ref.pageOrdinal,
        start: ref.start ?? -1,
        end: ref.end ?? -1,
      };
}

/**
 * Loads the sealed text chain a card cites into, from the item's active text
 * generation. A card generation reuses that chain and never makes one.
 */
async function requireCardTextChain(
  ctx: MutationCtx,
  sourceItemId: Id<"sourceItems">,
): Promise<{
  item: Doc<"sourceItems">;
  sourceRevisionId: Id<"sourceRevisions">;
  sourceTextVersionId: Id<"sourceTextVersions">;
}> {
  const item = await ctx.db.get(sourceItemId);
  if (!item) throw new Error("Card document does not exist");
  if (!item.activeGenerationId) {
    throw new Error("Card document has no active generation");
  }
  const base = await ctx.db.get(item.activeGenerationId);
  if (
    !base ||
    base.sourceItemId !== item._id ||
    base.state !== "ready" ||
    base.deactivatedAt !== undefined ||
    !base.sourceTextVersionId
  ) {
    throw new Error("Card document has no readable retained text");
  }
  return {
    item,
    sourceRevisionId: base.sourceRevisionId,
    sourceTextVersionId: base.sourceTextVersionId,
  };
}

/**
 * Turns the locations a runner cited into evidence spans over the sealed
 * retained text, one result per input in order, `null` where the location
 * could not be proved.
 *
 * Settled on review 2026-09-12: sealing protects the text and its pages, not
 * pointers into them, so a card generation may stage a span the parser never
 * made. Nothing here writes a page or a text version, and every span is
 * validated against the sealed page before it exists: the page is in this
 * text version, the range is inside it and on UTF-16 boundaries, the quote
 * hash is recomputed from that page's text, and a cited quote must occur
 * exactly once and match the slice character for character. A span that
 * already covers the same range, parser-staged or card-staged, is reused.
 */
export const stageCardEvidence = internalMutation({
  args: {
    sourceItemId: v.id("sourceItems"),
    recordKind: v.string(),
    fingerprint: v.object({
      cardSchemaVersion: v.number(),
      playbookVersion: v.string(),
      promptVersion: v.string(),
      tier: v.union(v.literal("local"), v.literal("tier0"), v.literal("tier1")),
    }),
    refs: v.array(cardEvidenceRefValidator),
  },
  returns: v.array(v.union(v.id("evidenceSpans"), v.null())),
  handler: async (ctx, args) => {
    if (!isCardRecordKind(args.recordKind)) {
      throw new Error("Unsupported card record kind");
    }
    const chain = await requireCardTextChain(ctx, args.sourceItemId);
    return await stageCardEvidenceSpans(ctx, {
      spaceId: chain.item.spaceId,
      sourceRevisionId: chain.sourceRevisionId,
      sourceTextVersionId: chain.sourceTextVersionId,
      cardExtractionFingerprint: cardExtractionFingerprint(
        args.recordKind,
        args.fingerprint,
      ),
      refs: args.refs.map(toCardEvidenceRef),
    });
  },
});

/**
 * Deletes the card-staged spans of one document that no surviving card
 * generation can reach: an abandoned staging attempt, or a generation that
 * was deleted. A retired card generation keeps its row and therefore its
 * spans, so its versions stay snapshot readable per section 4.6. Parser spans
 * carry no fingerprint and are never touched.
 */
export const sweepCardEvidence = internalMutation({
  args: { sourceItemId: v.id("sourceItems") },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const chain = await requireCardTextChain(ctx, args.sourceItemId);
    return {
      deleted: await sweepCardEvidenceSpans(ctx, {
        spaceId: chain.item.spaceId,
        sourceItemId: chain.item._id,
        sourceTextVersionId: chain.sourceTextVersionId,
      }),
    };
  },
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
      tier: v.union(v.literal("local"), v.literal("tier0"), v.literal("tier1")),
    }),
    anchorEvidenceSpanIds: v.array(v.id("evidenceSpans")),
    entityId: v.optional(v.id("entities")),
    fields: v.array(cardFieldValidator),
    runner: v.optional(
      v.object({
        modelId: v.string(),
        inputTokens: v.number(),
        outputTokens: v.number(),
        costMicroUsd: v.number(),
        wallTimeMs: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (!isCardRecordKind(args.recordKind)) {
      throw new Error("Unsupported card record kind");
    }
    const { recordKind, entityId, runner, ...rest } = args;
    return await publishDocumentCard(ctx, {
      ...rest,
      recordKind,
      ...(entityId === undefined ? {} : { entityId }),
      ...(runner === undefined ? {} : { runner }),
    });
  },
});
