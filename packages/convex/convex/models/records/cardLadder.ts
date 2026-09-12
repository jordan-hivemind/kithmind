import { v } from "convex/values";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  internalAction,
  internalQuery,
  type QueryCtx,
} from "../../_generated/server";
import { utf8ByteLength } from "../ingestion/hash";
import { MAX_EVIDENCE_SPANS, MAX_SOURCE_PAGES } from "../provenance/model";

import type { CardFieldInput, PublishCardResult } from "./cards";
import {
  CARD_EXTRACTION_MAX_TEXT_BYTES,
  CARD_PROMPT_VERSION,
  hostedCardRunners,
  localCardRunner,
  type CardRunner,
  type CardRunnerCandidate,
  type CardRunnerSpanRef,
  type CardRunnerStep,
} from "./cardRunner";
import { isCardRecordKind, type CardRecordKind } from "./cardSchemas";

/**
 * Section 5.1 of docs/plans/2026-09-12-document-cards.md: the extraction
 * ladder. L, then tier 0, then tier 1, then review.
 *
 * The ladder itself decides nothing about correctness. It runs a runner, turns
 * the runner's cited locations into evidence span ids, and hands the candidate
 * to `publishDocumentCard`, where the mechanical gate of P2-70d either accepts
 * the card or reports a required-field failure. The ladder reads that one
 * boolean and either stops or climbs. That is the whole escalation rule, and
 * it is why exactly one generation is ever staged: a step that fails stages
 * nothing, and the first step that passes publishes and ends the climb.
 */

export const CARD_PLAYBOOK_VERSION = "generic-1";
export const CARD_SCHEMA_VERSION = 1;

/** Closed refusal codes. A refusal is never a silent truncation or a guess. */
export const CARD_EXTRACTION_REFUSAL_CODES = [
  /** Document-first budgeting: the retained text is over the declared limit. */
  "document_too_large",
  /** The item has no readable sealed retained text to extract from. */
  "no_retained_text",
  /** Section 4.5: the source has no configured subject entity. */
  "no_subject_entity",
  /** Every ladder step reported itself unavailable. Nothing ran. */
  "no_runner_configured",
] as const;

export type CardExtractionRefusalCode =
  (typeof CARD_EXTRACTION_REFUSAL_CODES)[number];

export type CardLadderStepReport = {
  step: CardRunnerStep;
  modelId: string;
  outcome: "accepted" | "escalated" | "review" | "skipped";
};

export type CardLadderResult = {
  outcome: "accepted" | "review" | "refused";
  refusalCode?: CardExtractionRefusalCode;
  acceptedStep?: CardRunnerStep;
  processingGenerationId?: Id<"processingGenerations">;
  storedFields: string[];
  steps: CardLadderStepReport[];
};

// --- the document the runner is given -------------------------------------

export type CardExtractionDocument = {
  spaceId: Id<"spaces">;
  sourceItemId: Id<"sourceItems">;
  userId: Id<"users">;
  /** Page-delimited sealed retained text, so a value can cite where it is. */
  pages: Array<{ ordinal: number; text: string }>;
  /**
   * The evidence spans that already exist on this sealed text version. A card
   * generation reuses the text generation's sealed text and creates no span of
   * its own, so a location the runner cites is provable only when a span
   * already covers it. One that is not covered is not evidence, and its field
   * is refused rather than stored on an unprovable citation.
   */
  spans: Array<{
    spanId: Id<"evidenceSpans">;
    pageOrdinal: number;
    start: number;
    end: number;
  }>;
  textBytes: number;
};

export type CardExtractionLoad =
  | { status: "ready"; document: CardExtractionDocument }
  | { status: "refused"; code: CardExtractionRefusalCode };

export async function loadCardExtractionDocument(
  ctx: QueryCtx,
  sourceItemId: Id<"sourceItems">,
): Promise<CardExtractionLoad> {
  const item = await ctx.db.get(sourceItemId);
  if (!item || item.lifecycle !== "available" || !item.activeGenerationId) {
    return { status: "refused", code: "no_retained_text" };
  }
  const base = await ctx.db.get(item.activeGenerationId);
  if (
    !base ||
    base.sourceItemId !== item._id ||
    base.state !== "ready" ||
    base.deactivatedAt !== undefined ||
    !base.sourceTextVersionId
  ) {
    return { status: "refused", code: "no_retained_text" };
  }
  const account = await ctx.db.get(item.sourceAccountId);
  if (!account) return { status: "refused", code: "no_retained_text" };
  if (!account.subjectEntityId) {
    return { status: "refused", code: "no_subject_entity" };
  }
  const textVersionId = base.sourceTextVersionId;
  const pageRows = await ctx.db
    .query("sourcePages")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", textVersionId),
    )
    .take(MAX_SOURCE_PAGES + 1);
  if (pageRows.length === 0 || pageRows.length > MAX_SOURCE_PAGES) {
    return { status: "refused", code: "no_retained_text" };
  }
  const pages = pageRows
    .map((page) => ({ ordinal: page.ordinal, text: page.text }))
    .sort((left, right) => left.ordinal - right.ordinal);
  const textBytes = pages.reduce(
    (total, page) => total + utf8ByteLength(page.text),
    0,
  );
  if (textBytes > CARD_EXTRACTION_MAX_TEXT_BYTES) {
    // Refuse with a closed code rather than truncate. A shortened document
    // yields a card that cites a real span and omits the page that
    // contradicts it, which is worse than publishing no card at all.
    return { status: "refused", code: "document_too_large" };
  }
  const pageOrdinalById = new Map(
    pageRows.map((page) => [page._id, page.ordinal]),
  );
  const spanRows = await ctx.db
    .query("evidenceSpans")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", textVersionId),
    )
    .take(MAX_EVIDENCE_SPANS);
  return {
    status: "ready",
    document: {
      spaceId: item.spaceId,
      sourceItemId: item._id,
      userId: account.createdBy,
      pages,
      spans: spanRows.flatMap((span) => {
        const pageOrdinal = pageOrdinalById.get(span.sourcePageId);
        return pageOrdinal === undefined
          ? []
          : [
              {
                spanId: span._id,
                pageOrdinal,
                start: span.start,
                end: span.end,
              },
            ];
      }),
      textBytes,
    },
  };
}

// --- turning a cited location into an evidence span id --------------------

/**
 * A runner names a page ordinal plus a range, or a quote the code locates in
 * that page. Either way the result must be an evidence span that already
 * exists on the sealed text, and it must cover exactly that range: a span that
 * merely overlaps proves a different piece of text than the one cited. A quote
 * that appears more than once on its page is ambiguous and resolves to
 * nothing, which fails closed the way an ambiguous date does.
 */
export function resolveCardSpan(
  ref: CardRunnerSpanRef,
  document: Pick<CardExtractionDocument, "pages" | "spans">,
): Id<"evidenceSpans"> | undefined {
  const page = document.pages.find((row) => row.ordinal === ref.pageOrdinal);
  if (!page) return undefined;
  let start: number;
  let end: number;
  if ("quote" in ref) {
    start = page.text.indexOf(ref.quote);
    if (start < 0 || page.text.lastIndexOf(ref.quote) !== start) {
      return undefined;
    }
    end = start + ref.quote.length;
  } else {
    start = ref.start;
    end = ref.end;
  }
  return document.spans.find(
    (span) =>
      span.pageOrdinal === ref.pageOrdinal &&
      span.start === start &&
      span.end === end,
  )?.spanId;
}

function resolveCardSpans(
  refs: readonly CardRunnerSpanRef[],
  document: Pick<CardExtractionDocument, "pages" | "spans">,
): Id<"evidenceSpans">[] {
  const ids = refs.flatMap((ref) => {
    const id = resolveCardSpan(ref, document);
    return id ? [id] : [];
  });
  return [...new Set(ids)];
}

/**
 * A field whose citation resolves to no span keeps its empty evidence list
 * rather than disappearing. The gate then refuses it as `evidence_missing`,
 * which leaves a drop row, so nothing is silently dropped.
 */
export function resolveCardCandidate(
  candidate: CardRunnerCandidate,
  document: Pick<CardExtractionDocument, "pages" | "spans">,
): { anchorEvidenceSpanIds: Id<"evidenceSpans">[]; fields: CardFieldInput[] } {
  return {
    anchorEvidenceSpanIds: resolveCardSpans(candidate.anchor, document),
    fields: candidate.fields.map((field) => ({
      field: field.field,
      ...(field.ordinal === undefined ? {} : { ordinal: field.ordinal }),
      value: field.value,
      evidenceSpanIds: resolveCardSpans(field.spans, document),
    })),
  };
}

// --- the ladder -----------------------------------------------------------

/**
 * The two writes the ladder performs, injected so the ladder can be driven by
 * a fixture runner in a test without an action, and by the queue of P2-70f or
 * an operator command in production.
 */
export type CardLadderOps = {
  publish: (input: {
    recordKind: CardRecordKind;
    step: CardRunnerStep;
    now: number;
    anchorEvidenceSpanIds: Id<"evidenceSpans">[];
    fields: CardFieldInput[];
    runner: {
      modelId: string;
      inputTokens: number;
      outputTokens: number;
      costMicroUsd: number;
      wallTimeMs: number;
    };
  }) => Promise<PublishCardResult>;
  recordSkip: (input: {
    recordKind: CardRecordKind;
    step: CardRunnerStep;
    modelId: string;
    now: number;
  }) => Promise<void>;
};

/**
 * Runs one document through the ladder for one card kind.
 *
 * Exactly one generation is staged and activated, at the step the gate
 * accepted. A step whose required fields fail stages nothing and leaves an
 * attempt row; the next step runs from the same sealed text. At the top step a
 * required failure is `card_gate_failed` and a review item, and no typed card
 * publishes, which leaves any generic card already published untouched.
 */
export async function runCardLadder(input: {
  recordKind: CardRecordKind;
  document: CardExtractionDocument;
  runners: readonly CardRunner[];
  ops: CardLadderOps;
  now: number;
}): Promise<CardLadderResult> {
  const steps: CardLadderStepReport[] = [];
  const runnerInput = {
    recordKind: input.recordKind,
    pages: input.document.pages,
  };

  for (const runner of input.runners) {
    const output = await runner.run(runnerInput);
    if (output.status === "not_configured") {
      // Section 5.1: a skipped step is never reported as a passed step.
      await input.ops.recordSkip({
        recordKind: input.recordKind,
        step: runner.step,
        modelId: runner.modelId,
        now: input.now,
      });
      steps.push({
        step: runner.step,
        modelId: runner.modelId,
        outcome: "skipped",
      });
      continue;
    }
    const resolved = resolveCardCandidate(output.candidate, input.document);
    const published = await input.ops.publish({
      recordKind: input.recordKind,
      step: runner.step,
      now: input.now,
      anchorEvidenceSpanIds: resolved.anchorEvidenceSpanIds,
      fields: resolved.fields,
      runner: { modelId: runner.modelId, ...output.usage },
    });
    if (published.published || published.reason === "already_published") {
      steps.push({
        step: runner.step,
        modelId: runner.modelId,
        outcome: "accepted",
      });
      return {
        outcome: "accepted",
        acceptedStep: runner.step,
        ...(published.processingGenerationId
          ? { processingGenerationId: published.processingGenerationId }
          : {}),
        storedFields: published.storedFields,
        steps,
      };
    }
    if (published.reason === "no_subject_entity") {
      // Escalating cannot fix a source with no configured subject entity.
      return {
        outcome: "refused",
        refusalCode: "no_subject_entity",
        storedFields: [],
        steps,
      };
    }
    const top = runner.step === "tier1";
    steps.push({
      step: runner.step,
      modelId: runner.modelId,
      outcome: top ? "review" : "escalated",
    });
  }

  const ran = steps.some((step) => step.outcome !== "skipped");
  return ran
    ? { outcome: "review", storedFields: [], steps }
    : {
        outcome: "refused",
        refusalCode: "no_runner_configured",
        storedFields: [],
        steps,
      };
}

// --- the entry point ------------------------------------------------------

const refusalCodeValidator = v.union(
  ...CARD_EXTRACTION_REFUSAL_CODES.map((code) => v.literal(code)),
);

export const cardExtractionDocument = internalQuery({
  args: { sourceItemId: v.id("sourceItems") },
  handler: async (ctx, args) =>
    await loadCardExtractionDocument(ctx, args.sourceItemId),
});

/**
 * Runs the ladder for one document and one card kind. This is the single
 * entry point the throttled queue of P2-70f will call per queue row, and the
 * one an operator runs for a single document with
 * `npx convex run models/records/cardLadder:extractCard`.
 *
 * It is an action because tiers 0 and 1 reach a provider. The credential is
 * read here, from the same environment the embedding provider reads, and is
 * handed to the provider module alone: the runner interface carries no key,
 * the candidate carries no key, and nothing written by this path can.
 */
export const extractCard = internalAction({
  args: {
    sourceItemId: v.id("sourceItems"),
    kind: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.object({
    outcome: v.union(
      v.literal("accepted"),
      v.literal("review"),
      v.literal("refused"),
    ),
    refusalCode: v.optional(refusalCodeValidator),
    acceptedStep: v.optional(v.string()),
    processingGenerationId: v.optional(v.id("processingGenerations")),
    storedFields: v.array(v.string()),
    steps: v.array(
      v.object({
        step: v.string(),
        modelId: v.string(),
        outcome: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args): Promise<CardLadderResult> => {
    if (!isCardRecordKind(args.kind)) {
      throw new Error("Unsupported card record kind");
    }
    const recordKind: CardRecordKind = args.kind;
    const loaded: CardExtractionLoad = await ctx.runQuery(
      internal.models.records.cardLadder.cardExtractionDocument,
      { sourceItemId: args.sourceItemId },
    );
    if (loaded.status === "refused") {
      return {
        outcome: "refused",
        refusalCode: loaded.code,
        storedFields: [],
        steps: [],
      };
    }
    const document = loaded.document;
    const fingerprint = {
      cardSchemaVersion: CARD_SCHEMA_VERSION,
      playbookVersion: CARD_PLAYBOOK_VERSION,
      promptVersion: CARD_PROMPT_VERSION,
    };
    const now = args.now ?? Date.now();
    return await runCardLadder({
      recordKind,
      document,
      now,
      runners: [localCardRunner(), ...hostedCardRunners(process.env)],
      ops: {
        publish: async (input) =>
          await ctx.runMutation(internal.models.records.cards.publishCard, {
            spaceId: document.spaceId,
            sourceItemId: document.sourceItemId,
            userId: document.userId,
            recordKind: input.recordKind,
            now: input.now,
            fingerprint: { ...fingerprint, tier: input.step },
            anchorEvidenceSpanIds: input.anchorEvidenceSpanIds,
            fields: input.fields,
            runner: input.runner,
          }),
        recordSkip: async (input) => {
          await ctx.runMutation(
            internal.models.records.cards.recordSkippedCardAttempt,
            {
              sourceItemId: document.sourceItemId,
              recordKind: input.recordKind,
              step: input.step,
              modelId: input.modelId,
              fingerprint: { ...fingerprint, tier: input.step },
              now: input.now,
            },
          );
        },
      },
    });
  },
});
