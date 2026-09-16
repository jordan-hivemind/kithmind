// P2-39g2: incremental admission. Embed the targets the active fingerprint
// still owes, and nothing else.
//
// Ported from `models/embeddings/fill.ts` (`nextEmbeddingFillPage`,
// `commitEmbeddingFillPage`, `runEmbeddingFill`).
//
// The owed set is an index page, not a scan: a target is owed exactly while it
// is eligible and carries no coverage marker, and the insert that covers it
// removes it from migration 016's partial index, so the fill needs no cursor of
// its own. Every failure resolves the same way:
//
//   * a lost provider call leaves the target uncovered, so the next page
//     re-embeds it;
//   * a replayed commit finds the target already covered and writes nothing;
//   * a page that crashes before its commit leaves the owed index unchanged.
//
// Two things differ from the Convex original, both consequences of section 2.6
// of the consolidation plan rather than of this port.
//
// 1. No scheduler. Convex's commit mutation scheduled its own successor inside
//    its transaction. Here `runEmbeddingFill` is a plain async driver that runs
//    page after page until nothing is owed, and each page is its own
//    `withKithTransaction`. The daemon that calls it on a schedule is row j.
//
// 2. The provider is injected. `runEmbeddingFill` takes an embedder rather than
//    reaching for `generateEmbeddingWithMetadata`, so a test needs no network
//    and a read transaction never blocks on an HTTP call it did not ask for.
//    The page size is still the plan's 32 inputs per request.
//
// The read page and the commit are separate transactions on purpose: the
// provider call sits between them and a transaction may not be held open
// across it. Everything the commit needs is rechecked inside the commit's own
// transaction -- the active fingerprint, the target's eligibility, its hash and
// its live text -- so nothing the read page saw is trusted after the fact.

import { identityCtx, row, type IdentityCtx } from "../identity/db.js";
import { withKithTransaction } from "../schema.js";
import { sha256Utf8 } from "../provenance/sql.js";
import { composeCardTargetInput } from "./cardTargets.js";
import {
  EMBEDDING_FILL_PAGE,
  findEmbeddingTargetRow,
  owedTargetsPage,
  assertTargetKind,
  type EmbeddingTargetWriteRow,
} from "./eligibility.js";
import type { EmbeddingTargetKind } from "./scope.js";
import { uniqueSpaceState } from "./state.js";
import { usesTargetCounters } from "./targets.js";
import {
  insertCardEmbedding,
  insertChunkEmbedding,
  insertThoughtEmbedding,
} from "./write.js";

import type pg from "pg";

/** One page is one provider batch: the plan's 32 inputs per request. */
export const MAX_FILL_VECTORS = EMBEDDING_FILL_PAGE;

export type EmbeddingFillTarget = {
  targetKind: EmbeddingTargetKind;
  targetId: string;
  inputHash: string;
  inputText: string;
};

export type EmbeddingFillPage = {
  fingerprint: string | null;
  counted: boolean;
  targets: EmbeddingFillTarget[];
};

export type EmbeddingFillVector = {
  targetKind: EmbeddingTargetKind;
  targetId: string;
  inputHash: string;
  vector: readonly number[];
};

export type EmbeddingFillCommit = {
  embedded: number;
  skipped: number;
  remaining: boolean;
};

export type EmbeddingFillResult = {
  pages: number;
  requested: number;
  embedded: number;
  skipped: number;
  remaining: boolean;
};

/**
 * What a caller wires the provider in as. One call per page, 32 texts at most,
 * returning one result per text in order. `fingerprint` comes back with each
 * vector because the commit refuses a page whose profile is not the one the
 * space is active on, and a driver that only returned vectors could not tell.
 */
export type FillEmbedder = (
  texts: readonly string[],
) => Promise<ReadonlyArray<{ vector: number[]; fingerprint: string }>>;

async function liveTargetText(
  ctx: IdentityCtx,
  spaceId: string,
  record: EmbeddingTargetWriteRow,
): Promise<string | null> {
  const kind = assertTargetKind(record.target_kind);
  if (!record.target_id) return null;
  if (kind === "thought") {
    const thought = await row<{ space_id: string; content: string }>(
      ctx,
      "SELECT space_id, content FROM kith.thoughts WHERE id = $1",
      [record.target_id],
    );
    return thought && thought.space_id === spaceId ? thought.content : null;
  }
  if (kind === "chunk") {
    const chunk = await row<{ space_id: string; text: string | null }>(
      ctx,
      "SELECT space_id, text FROM kith.chunks WHERE id = $1",
      [record.target_id],
    );
    return chunk && chunk.space_id === spaceId ? (chunk.text ?? "") : null;
  }
  const event = await row<{
    id: string;
    space_id: string;
    source_item_id: string | null;
    event_key: string | null;
  }>(
    ctx,
    "SELECT id, space_id, source_item_id, event_key FROM kith.events WHERE id = $1",
    [record.target_id],
  );
  if (!event || event.space_id !== spaceId || !event.source_item_id) {
    return null;
  }
  const composed = await composeCardTargetInput(
    ctx,
    spaceId,
    event.source_item_id,
    event,
  );
  return composed?.text ?? null;
}

/** The next page of targets the active fingerprint owes, with their inputs. */
export async function nextEmbeddingFillPage(
  ctx: IdentityCtx,
  spaceId: string,
  limit: number = MAX_FILL_VECTORS,
): Promise<EmbeddingFillPage> {
  const state = await uniqueSpaceState(ctx, spaceId);
  if (!state || !usesTargetCounters(state)) {
    return { fingerprint: null, counted: false, targets: [] };
  }
  if (!state.active_fingerprint || !state.active_embedding_generation_id) {
    return { fingerprint: null, counted: true, targets: [] };
  }
  const owed = await owedTargetsPage(ctx, spaceId, limit);
  const targets: EmbeddingFillTarget[] = [];
  for (const record of owed) {
    const text = await liveTargetText(ctx, spaceId, record);
    // I7: a target whose live text has moved on since its eligibility write is
    // skipped rather than embedded against a stale hash. The write that
    // changed it refreshed the row, so the next page sees the new hash.
    if (text === null || (await sha256Utf8(text)) !== record.input_hash) {
      continue;
    }
    targets.push({
      targetKind: assertTargetKind(record.target_kind),
      targetId: record.target_id!,
      inputHash: record.input_hash!,
      inputText: text,
    });
  }
  return {
    fingerprint: state.active_fingerprint,
    counted: true,
    targets,
  };
}

/** Inserts one page of vectors. Idempotent: a replay writes nothing. */
export async function commitEmbeddingFillPage(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    fingerprint: string;
    vectors: readonly EmbeddingFillVector[];
  },
): Promise<EmbeddingFillCommit> {
  if (input.vectors.length > MAX_FILL_VECTORS) {
    throw new Error("Embedding fill page exceeds its vector budget");
  }
  const state = await uniqueSpaceState(ctx, input.spaceId, true);
  if (!state) throw new Error("Space embedding state not found");
  const generationId = state.active_embedding_generation_id;
  if (state.active_fingerprint !== input.fingerprint || !generationId) {
    // The space activated a different profile while this page was in the
    // provider. Its vectors cover nothing; refusing them leaves the targets
    // owed, and the next pass re-embeds under the fingerprint now active.
    throw new Error("Embedding fill fingerprint is no longer active");
  }
  let embedded = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const supplied of input.vectors) {
    const key = `${supplied.targetKind}:${supplied.targetId}`;
    if (seen.has(key)) {
      throw new Error("Embedding fill page contains a duplicate target");
    }
    seen.add(key);
    const record = await findEmbeddingTargetRow(
      ctx,
      input.spaceId,
      supplied.targetKind,
      supplied.targetId,
    );
    if (
      !record ||
      record.state !== "eligible" ||
      record.input_hash !== supplied.inputHash ||
      record.covered_fingerprint === input.fingerprint
    ) {
      // Retired, rewritten, or already covered by a replay of this page.
      skipped += 1;
      continue;
    }
    const text = await liveTargetText(ctx, input.spaceId, record);
    if (text === null || (await sha256Utf8(text)) !== record.input_hash) {
      skipped += 1;
      continue;
    }
    if (supplied.targetKind === "thought") {
      await insertThoughtEmbedding(ctx, {
        spaceId: input.spaceId,
        thoughtId: supplied.targetId,
        embeddingGenerationId: generationId,
        fingerprint: input.fingerprint,
        inputText: text,
        vector: supplied.vector,
        bumpEligibility: false,
      });
    } else if (supplied.targetKind === "chunk") {
      await insertChunkEmbedding(ctx, {
        spaceId: input.spaceId,
        chunkId: supplied.targetId,
        embeddingGenerationId: generationId,
        fingerprint: input.fingerprint,
        inputText: text,
        vector: supplied.vector,
        bumpEligibility: false,
      });
    } else {
      await insertCardEmbedding(ctx, {
        spaceId: input.spaceId,
        eventId: supplied.targetId,
        embeddingGenerationId: generationId,
        fingerprint: input.fingerprint,
        inputText: text,
        vector: supplied.vector,
        bumpEligibility: false,
      });
    }
    embedded += 1;
  }
  const remaining = (await owedTargetsPage(ctx, input.spaceId, 1)).length > 0;
  return { embedded, skipped, remaining };
}

/** Whether a space still owes this fingerprint anything. */
export async function embeddingFillRemaining(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<boolean> {
  return (await owedTargetsPage(ctx, spaceId, 1)).length > 0;
}

/**
 * The provider fill driver: page after page until nothing is owed.
 *
 * Each page is a read transaction, one provider call, and a commit
 * transaction. `maxPages` bounds a single invocation so a caller that wants a
 * slice of the backlog gets one; the default runs the space to completion,
 * which is what the daemon wants. A page that embeds nothing ends the run
 * rather than looping: if every owed target was skipped, running the same page
 * again would skip them again.
 */
export async function runEmbeddingFill(
  pool: pg.Pool,
  spaceId: string,
  embed: FillEmbedder,
  options: {
    limit?: number;
    maxPages?: number;
    now?: () => number;
  } = {},
): Promise<EmbeddingFillResult> {
  const limit = Math.min(
    Math.max(options.limit ?? MAX_FILL_VECTORS, 1),
    MAX_FILL_VECTORS,
  );
  const maxPages = Math.max(options.maxPages ?? Number.MAX_SAFE_INTEGER, 1);
  const clock = options.now ?? (() => Date.now());
  const totals: EmbeddingFillResult = {
    pages: 0,
    requested: 0,
    embedded: 0,
    skipped: 0,
    remaining: false,
  };
  for (let page = 0; page < maxPages; page += 1) {
    const next = await withKithTransaction(pool, (client) =>
      nextEmbeddingFillPage(identityCtx(client, clock()), spaceId, limit),
    );
    if (!next.fingerprint || next.targets.length === 0) {
      totals.remaining = false;
      return totals;
    }
    const results = await embed(next.targets.map((target) => target.inputText));
    if (results.length !== next.targets.length) {
      throw new Error("Embedding fill provider returned the wrong batch size");
    }
    const vectors: EmbeddingFillVector[] = next.targets.map((target, index) => {
      const result = results[index]!;
      if (result.fingerprint !== next.fingerprint) {
        throw new Error(
          "Embedding fill provider profile does not match the active fingerprint",
        );
      }
      return {
        targetKind: target.targetKind,
        targetId: target.targetId,
        inputHash: target.inputHash,
        vector: result.vector,
      };
    });
    const committed = await withKithTransaction(pool, (client) =>
      commitEmbeddingFillPage(identityCtx(client, clock()), {
        spaceId,
        fingerprint: next.fingerprint!,
        vectors,
      }),
    );
    totals.pages += 1;
    totals.requested += vectors.length;
    totals.embedded += committed.embedded;
    totals.skipped += committed.skipped;
    totals.remaining = committed.remaining;
    if (!committed.remaining || committed.embedded === 0) return totals;
  }
  return totals;
}
