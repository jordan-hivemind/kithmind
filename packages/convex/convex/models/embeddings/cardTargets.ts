import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { MAX_GENERATION_DOCUMENTS } from "../provenance/model";
import { cardEventKey } from "../records/cardSchemas";

/**
 * Section 8 of docs/plans/2026-09-12-document-cards.md: the card embedding
 * target, and the full-chunk opt-in that replaces chunk-per-document
 * eligibility.
 *
 * One composition function serves every path that needs the card's embedded
 * text: the eligibility write, the scan page, the provider fill and the
 * reader's I7 recheck. They cannot disagree about what a card target is,
 * because there is one definition of it.
 */

/** The generic card. Typed cards ride on the same document and add no target. */
export const CARD_TARGET_EVENT_KEY = cardEventKey("document_card");

/** A card publishes at most 128 observations; the generic card holds a handful. */
const MAX_CARD_OBSERVATIONS = 128;

/** Keeps one composed input inside the plan's ~2 KiB per-card text budget. */
const MAX_CARD_INPUT_CHARS = 4_000;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type CardTargetInput = {
  eventId: Id<"events">;
  /** The live card generation. The evidence pointer a card hit reports. */
  cardGenerationId: Id<"processingGenerations">;
  /** The composed embedded text: kind, title, date, parties and summary. */
  text: string;
  /** The passage a card hit returns, which is the extractive summary. */
  summary: string;
  /** Evidence spans a card hit's citations resolve to. */
  evidenceSpanIds: Id<"evidenceSpans">[];
  /** Active documents of the item's text generation, for document-level hits. */
  documentIds: Id<"documents">[];
};

/**
 * Section 8.2. Absent on the item falls back to the source account's rule and
 * absent there is off, so a new document admitted without an opt-in produces
 * card targets only. Chunks stay retained and keyword-indexed either way;
 * this governs embedding eligibility alone.
 */
export function chunkTargetsOptedIn(
  item: Doc<"sourceItems">,
  account: Doc<"sourceAccounts"> | null,
): boolean {
  return item.embedFullChunks ?? account?.embedFullChunks ?? false;
}

/**
 * True while the space still embeds every active chunk. Absent means
 * `all_chunks`, so deploying this change retires nothing: an operator flips
 * the space only after the grandfathering migration and the frozen scorer
 * rerun.
 */
export function spaceEmbedsAllChunks(
  state: Doc<"spaceEmbeddingStates">,
): boolean {
  return (state.targetPolicy ?? "all_chunks") === "all_chunks";
}

/** The generic card event of one source item, or null when it has none. */
export async function findCardTargetEvent(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  sourceItemId: Id<"sourceItems">,
): Promise<Doc<"events"> | null> {
  const event = await ctx.db
    .query("events")
    .withIndex("by_sourceItemId_and_eventKey", (q) =>
      q.eq("sourceItemId", sourceItemId).eq("eventKey", CARD_TARGET_EVENT_KEY),
    )
    .unique();
  return event && event.spaceId === spaceId ? event : null;
}

function appendField(parts: string[], label: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) parts.push(`${label}: ${trimmed}`);
}

/**
 * The composed card input of section 8.1: `card_kind`, `card_title`,
 * `card_date`, the `card_party` values and `card_summary`, in that fixed
 * order. Its hash is therefore stable while those accepted fields are stable,
 * which is what lets a re-chunk, a parser change or a re-extraction reuse the
 * vector.
 *
 * Returns null when the item has no live generic card, which is exactly when
 * the target must be retired: no active card generation, an abandoned or
 * superseded one, a forgotten item, or a card with no title.
 */
export async function composeCardTargetInput(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  sourceItemId: Id<"sourceItems">,
  event?: Doc<"events"> | null,
): Promise<CardTargetInput | null> {
  const item = await ctx.db.get(sourceItemId);
  if (!item || item.spaceId !== spaceId) return null;
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    return null;
  }
  const cardGenerationId = item.activeCardGenerationId;
  if (!cardGenerationId) return null;
  const generation = await ctx.db.get(cardGenerationId);
  if (
    !generation ||
    generation.spaceId !== spaceId ||
    generation.sourceItemId !== item._id ||
    generation.cardGeneration !== true ||
    generation.state !== "ready" ||
    generation.deactivatedAt !== undefined
  ) {
    return null;
  }
  const cardEvent =
    event !== undefined
      ? event
      : await findCardTargetEvent(ctx, spaceId, sourceItemId);
  if (!cardEvent || cardEvent.sourceItemId !== item._id) return null;

  // The version this generation published, not the event's whole history: a
  // retired generation keeps its rows and must not feed the live index.
  const version = await ctx.db
    .query("eventVersions")
    .withIndex("by_eventId_and_processingGenerationId", (q) =>
      q.eq("eventId", cardEvent._id).eq("processingGenerationId", generation._id),
    )
    .unique();
  if (!version || version.spaceId !== spaceId) return null;

  const observations = await ctx.db
    .query("observations")
    .withIndex("by_eventVersionId", (q) => q.eq("eventVersionId", version._id))
    .take(MAX_CARD_OBSERVATIONS + 1);
  if (observations.length > MAX_CARD_OBSERVATIONS) {
    throw new Error("Card target exceeds its observation bound");
  }

  const byType = new Map<string, Doc<"observations">[]>();
  for (const row of observations) {
    if (row.spaceId !== spaceId) {
      throw new Error("Card observation belongs to another space");
    }
    const bucket = byType.get(row.observationType) ?? [];
    bucket.push(row);
    byType.set(row.observationType, bucket);
  }
  const ordered = (type: string) =>
    [...(byType.get(type) ?? [])].sort((left, right) =>
      left.observationKey.localeCompare(right.observationKey),
    );
  // A name field stores `text` until P2-70l binds it and `entity` after, so
  // the composed input reads the canonical name either way. The composition
  // is the same string in both cases, which is what keeps re-extraction and
  // later binding from re-embedding a card whose meaning never moved.
  const valueText = async (
    row: Doc<"observations"> | undefined,
  ): Promise<string> => {
    if (!row) return "";
    if (row.value.type === "text" || row.value.type === "date") {
      return row.value.value;
    }
    if (row.value.type !== "entity") return "";
    const entity = await ctx.db.get(row.value.entityId);
    return entity && entity.spaceId === spaceId ? entity.canonicalName : "";
  };
  const text = async (type: string): Promise<string> =>
    await valueText(ordered(type)[0]);

  const title = await text("card_title");
  // `card_title` is the card's only required field, so a card with none is
  // not a card. Embedding an empty or party-only string would put a
  // meaningless vector in a fixed candidate budget.
  if (!title.trim()) return null;

  const parts: string[] = [];
  appendField(parts, "Kind", await text("card_kind"));
  appendField(parts, "Title", title);
  appendField(parts, "Date", await text("card_date"));
  const parties: string[] = [];
  for (const row of ordered("card_party")) {
    const name = (await valueText(row)).trim();
    if (name) parties.push(name);
  }
  if (parties.length > 0) appendField(parts, "Parties", parties.join(", "));
  const summary = await text("card_summary");
  appendField(parts, "Summary", summary);

  const evidenceSpanIds = [
    ...new Set([
      ...version.fieldEvidence.eventType,
      ...ordered("card_summary").flatMap((row) => row.valueEvidence),
      ...ordered("card_title").flatMap((row) => row.valueEvidence),
    ]),
  ];

  const documents = item.activeGenerationId
    ? await ctx.db
        .query("documents")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", item.activeGenerationId!),
        )
        .take(MAX_GENERATION_DOCUMENTS + 1)
    : [];
  if (documents.length > MAX_GENERATION_DOCUMENTS) {
    throw new Error("Card target generation exceeds the document bound");
  }

  return {
    eventId: cardEvent._id,
    cardGenerationId: generation._id,
    text: parts.join("\n").slice(0, MAX_CARD_INPUT_CHARS),
    summary: summary.trim() || title.trim(),
    evidenceSpanIds,
    documentIds: documents
      .filter(
        (row) => row.spaceId === spaceId && row.publicationState === "active",
      )
      .map((row) => row._id),
  };
}
