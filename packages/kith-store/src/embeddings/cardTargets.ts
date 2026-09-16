// Ported from packages/convex/convex/models/embeddings/cardTargets.ts, read
// half only: `composeCardTargetInput` and the event lookup it uses.
//
// Section 8 of docs/plans/2026-09-12-document-cards.md gives one composition
// function to every path that needs a card's embedded text -- the eligibility
// write, the scan page, the provider fill and the reader's I7 recheck -- so
// they cannot disagree about what a card target is. On this side the reader
// is the only one of the four that exists yet, and it needs the composition
// for its recheck: a card vector is accepted only if recomposing the live
// card still hashes to the `input_hash` the row was written with. That is the
// whole point of the check, so the composition is ported rather than assumed.
//
// `chunkTargetsOptedIn` and `spaceEmbedsAllChunks` are not ported: both are
// eligibility-write policy, which belongs to the writer the embedding build
// workstream owns, not to a retrieval path.

import { sha256Utf8 } from "../provenance/sql.js";
import { rows, row, type IdentityCtx } from "../identity/db.js";

/** The generic card. Typed cards ride on the same document and add no target. */
export const CARD_TARGET_EVENT_KEY = "card:document_card";

/** A card publishes at most 128 observations; the generic card holds a handful. */
const MAX_CARD_OBSERVATIONS = 128;

/** Keeps one composed input inside the plan's ~2 KiB per-card text budget. */
const MAX_CARD_INPUT_CHARS = 4_000;

/** `MAX_GENERATION_DOCUMENTS` in `../provenance/model.ts`, restated to keep
 * this module free of a cycle through the provenance service surface. */
const MAX_GENERATION_DOCUMENTS = 16;

export type CardTargetInput = {
  eventId: string;
  /** The live card generation. The evidence pointer a card hit reports. */
  cardGenerationId: string;
  /** The composed embedded text: kind, title, date, parties and summary. */
  text: string;
  /** The passage a card hit returns, which is the extractive summary. */
  summary: string;
  /** Evidence spans a card hit's citations resolve to. */
  evidenceSpanIds: string[];
  /** Active documents of the item's text generation, for document-level hits. */
  documentIds: string[];
};

type EventRow = {
  id: string;
  space_id: string;
  source_item_id: string | null;
  event_key: string | null;
};

type ObservationRow = {
  id: string;
  space_id: string;
  observation_key: string | null;
  observation_type: string | null;
  value: unknown;
  value_evidence: unknown;
};

function evidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Card evidence is invalid");
  for (const id of value) {
    if (typeof id !== "string") throw new Error("Card evidence is invalid");
  }
  return value as string[];
}

/** The generic card event of one source item, or null when it has none. */
export async function findCardTargetEvent(
  ctx: IdentityCtx,
  spaceId: string,
  sourceItemId: string,
): Promise<EventRow | null> {
  const found = await rows<EventRow>(
    ctx,
    `SELECT id, space_id, source_item_id, event_key FROM kith.events
      WHERE source_item_id = $1 AND event_key = $2 LIMIT 2`,
    [sourceItemId, CARD_TARGET_EVENT_KEY],
  );
  if (found.length > 1) throw new Error("Card event identity is not unique");
  const event = found[0];
  return event && event.space_id === spaceId ? event : null;
}

function appendField(parts: string[], label: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) parts.push(`${label}: ${trimmed}`);
}

/**
 * The composed card input of section 8.1: `card_kind`, `card_title`,
 * `card_date`, the `card_party` values and `card_summary`, in that fixed
 * order. Its hash is stable while those accepted fields are stable, which is
 * what lets a re-chunk, a parser change or a re-extraction reuse the vector.
 *
 * Returns null when the item has no live generic card, which is exactly when
 * the target must be retired: no active card generation, an abandoned or
 * superseded one, a forgotten item, or a card with no title.
 */
export async function composeCardTargetInput(
  ctx: IdentityCtx,
  spaceId: string,
  sourceItemId: string,
  event?: EventRow | null,
): Promise<CardTargetInput | null> {
  const item = await row<{
    id: string;
    space_id: string;
    lifecycle: string | null;
    active_generation_id: string | null;
    active_card_generation_id: string | null;
  }>(
    ctx,
    `SELECT id, space_id, lifecycle, active_generation_id, active_card_generation_id
       FROM kith.source_items WHERE id = $1`,
    [sourceItemId],
  );
  if (!item || item.space_id !== spaceId) return null;
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    return null;
  }
  const cardGenerationId = item.active_card_generation_id;
  if (!cardGenerationId) return null;
  const generation = await row<{
    id: string;
    space_id: string;
    source_item_id: string | null;
    card_generation: boolean | null;
    state: string | null;
    deactivated_at: Date | null;
  }>(
    ctx,
    `SELECT id, space_id, source_item_id, card_generation, state, deactivated_at
       FROM kith.processing_generations WHERE id = $1`,
    [cardGenerationId],
  );
  if (
    !generation ||
    generation.space_id !== spaceId ||
    generation.source_item_id !== item.id ||
    generation.card_generation !== true ||
    generation.state !== "ready" ||
    generation.deactivated_at !== null
  ) {
    return null;
  }
  const cardEvent =
    event !== undefined
      ? event
      : await findCardTargetEvent(ctx, spaceId, sourceItemId);
  if (!cardEvent || cardEvent.source_item_id !== item.id) return null;

  // The version this generation published, not the event's whole history: a
  // retired generation keeps its rows and must not feed the live index.
  const versions = await rows<{
    id: string;
    space_id: string;
    field_evidence: unknown;
  }>(
    ctx,
    `SELECT id, space_id, field_evidence FROM kith.event_versions
      WHERE event_id = $1 AND processing_generation_id = $2 LIMIT 2`,
    [cardEvent.id, generation.id],
  );
  if (versions.length > 1) {
    throw new Error("Card event version identity is not unique");
  }
  const version = versions[0];
  if (!version || version.space_id !== spaceId) return null;

  const observations = await rows<ObservationRow>(
    ctx,
    `SELECT id, space_id, observation_key, observation_type, value, value_evidence
       FROM kith.observations WHERE event_version_id = $1 LIMIT $2`,
    [version.id, MAX_CARD_OBSERVATIONS + 1],
  );
  if (observations.length > MAX_CARD_OBSERVATIONS) {
    throw new Error("Card target exceeds its observation bound");
  }

  const byType = new Map<string, ObservationRow[]>();
  for (const record of observations) {
    if (record.space_id !== spaceId) {
      throw new Error("Card observation belongs to another space");
    }
    const type = record.observation_type ?? "";
    const bucket = byType.get(type) ?? [];
    bucket.push(record);
    byType.set(type, bucket);
  }
  const ordered = (type: string) =>
    [...(byType.get(type) ?? [])].sort((left, right) =>
      (left.observation_key ?? "").localeCompare(right.observation_key ?? ""),
    );
  // A name field stores `text` until the binding lands and `entity` after, so
  // the composed input reads the canonical name either way. The composition
  // is the same string in both cases, which is what keeps re-extraction and
  // later binding from re-embedding a card whose meaning never moved.
  const valueText = async (record: ObservationRow | undefined) => {
    if (!record) return "";
    const value = record.value;
    if (!value || typeof value !== "object") return "";
    const typed = value as {
      type?: unknown;
      value?: unknown;
      entityId?: unknown;
    };
    if (typed.type === "text" || typed.type === "date") {
      return typeof typed.value === "string" ? typed.value : "";
    }
    if (typed.type !== "entity" || typeof typed.entityId !== "string")
      return "";
    const entity = await row<{ space_id: string; canonical_name: string }>(
      ctx,
      "SELECT space_id, canonical_name FROM kith.entities WHERE id = $1",
      [typed.entityId],
    );
    return entity && entity.space_id === spaceId ? entity.canonical_name : "";
  };
  const text = async (type: string) => await valueText(ordered(type)[0]);

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
  for (const record of ordered("card_party")) {
    const name = (await valueText(record)).trim();
    if (name) parties.push(name);
  }
  if (parties.length > 0) appendField(parts, "Parties", parties.join(", "));
  const summary = await text("card_summary");
  appendField(parts, "Summary", summary);

  const fieldEvidence = version.field_evidence;
  if (!fieldEvidence || typeof fieldEvidence !== "object") {
    throw new Error("Card evidence is invalid");
  }
  const evidenceSpanIds = [
    ...new Set([
      ...evidenceIds((fieldEvidence as Record<string, unknown>).eventType),
      ...ordered("card_summary").flatMap((record) =>
        evidenceIds(record.value_evidence),
      ),
      ...ordered("card_title").flatMap((record) =>
        evidenceIds(record.value_evidence),
      ),
    ]),
  ];

  const documents = item.active_generation_id
    ? await rows<{ id: string; space_id: string; publication_state: string }>(
        ctx,
        `SELECT id, space_id, publication_state FROM kith.documents
          WHERE processing_generation_id = $1 LIMIT $2`,
        [item.active_generation_id, MAX_GENERATION_DOCUMENTS + 1],
      )
    : [];
  if (documents.length > MAX_GENERATION_DOCUMENTS) {
    throw new Error("Card target generation exceeds the document bound");
  }

  return {
    eventId: cardEvent.id,
    cardGenerationId: generation.id,
    text: parts.join("\n").slice(0, MAX_CARD_INPUT_CHARS),
    summary: summary.trim() || title.trim(),
    evidenceSpanIds,
    documentIds: documents
      .filter(
        (record) =>
          record.space_id === spaceId && record.publication_state === "active",
      )
      .map((record) => record.id),
  };
}

/** The content fingerprint a card vector's `input_hash` is compared against. */
export async function cardTargetInputHash(
  composed: CardTargetInput,
): Promise<string> {
  return await sha256Utf8(composed.text);
}
