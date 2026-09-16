// P2-39g2: the chunk parent chain a whole-space path validates before it will
// call a chunk an embedding target.
//
// Ported from `resolveActiveChunkTarget` and `newChunkTargetCaches` in
// `models/embeddings/targets.ts`. Two callers need it and they are both
// whole-space reads: `deriveEmbeddingManifest` (the profile-transition
// driver's one-transaction manifest) and the build's chunk scan page. The
// per-write path in `eligibility.ts` deliberately does *not* use it: it reads
// the same chain once per processing generation instead of once per chunk, and
// without the assertions, because a generation that the write just deactivated
// is expected to fail them.
//
// The caches are the same idea as the Convex original's: one page touches a
// handful of generations, items, accounts, revisions and text versions across
// up to 128 chunks, so reading each one once per page rather than once per
// chunk is the difference between 5 statements and 640.

import { row, type IdentityCtx } from "../identity/db.js";
import { chunkTargetsOptedIn } from "./cardTargets.js";

export type ChunkRow = {
  id: string;
  space_id: string;
  processing_generation_id: string | null;
  document_id: string | null;
  text: string | null;
  publication_state: string | null;
};

type DocumentRow = {
  id: string;
  space_id: string;
  processing_generation_id: string | null;
  source_item_id: string | null;
  source_revision_id: string | null;
  source_text_version_id: string | null;
  publication_state: string | null;
};

type GenerationRow = {
  id: string;
  space_id: string;
  source_account_id: string | null;
  source_item_id: string | null;
  source_revision_id: string | null;
  source_text_version_id: string | null;
  state: string | null;
};

export type SourceItemRow = {
  id: string;
  space_id: string;
  source_account_id: string | null;
  lifecycle: string | null;
  active_revision_id: string | null;
  active_generation_id: string | null;
  active_card_generation_id: string | null;
  embed_full_chunks: boolean | null;
};

export const SOURCE_ITEM_COLUMNS = `id, space_id, source_account_id, lifecycle,
  active_revision_id, active_generation_id, active_card_generation_id,
  embed_full_chunks`;

export type SourceAccountRow = {
  id: string;
  space_id: string;
  embed_full_chunks: boolean | null;
};

type RevisionRow = {
  id: string;
  space_id: string;
  source_item_id: string | null;
};

type TextVersionRow = {
  id: string;
  space_id: string;
  source_revision_id: string | null;
  evidence_sealed: boolean | null;
};

export type ChunkTargetCaches = {
  documents: Map<string, DocumentRow | null>;
  generations: Map<string, GenerationRow | null>;
  items: Map<string, SourceItemRow | null>;
  accounts: Map<string, SourceAccountRow | null>;
  revisions: Map<string, RevisionRow | null>;
  textVersions: Map<string, TextVersionRow | null>;
};

export function newChunkTargetCaches(): ChunkTargetCaches {
  return {
    documents: new Map(),
    generations: new Map(),
    items: new Map(),
    accounts: new Map(),
    revisions: new Map(),
    textVersions: new Map(),
  };
}

async function cached<T extends object>(
  cache: Map<string, T | null>,
  id: string | null,
  load: (id: string) => Promise<T | null>,
): Promise<T | null> {
  if (!id) return null;
  if (cache.has(id)) return cache.get(id) ?? null;
  const loaded = await load(id);
  cache.set(id, loaded);
  return loaded;
}

export async function loadSourceItem(
  ctx: IdentityCtx,
  id: string,
): Promise<SourceItemRow | null> {
  return await row<SourceItemRow>(
    ctx,
    `SELECT ${SOURCE_ITEM_COLUMNS} FROM kith.source_items WHERE id = $1`,
    [id],
  );
}

export async function loadSourceAccount(
  ctx: IdentityCtx,
  id: string,
): Promise<SourceAccountRow | null> {
  return await row<SourceAccountRow>(
    ctx,
    "SELECT id, space_id, embed_full_chunks FROM kith.source_accounts WHERE id = $1",
    [id],
  );
}

/**
 * Validates an active chunk's whole parent chain. Returns null when the chunk
 * belongs to a forgotten source item, which is a skip rather than a fault;
 * anything else inconsistent throws, because a whole-space scan that silently
 * skipped a broken chain would build a manifest that claims to be complete.
 */
export async function resolveActiveChunkTarget(
  ctx: IdentityCtx,
  spaceId: string,
  chunk: ChunkRow,
  caches: ChunkTargetCaches,
): Promise<{
  processingGenerationId: string;
  /** Section 8.2: whether this chunk's item carries the full-chunk opt-in. */
  optedIn: boolean;
} | null> {
  const document = await cached(caches.documents, chunk.document_id, (id) =>
    row<DocumentRow>(
      ctx,
      `SELECT id, space_id, processing_generation_id, source_item_id,
              source_revision_id, source_text_version_id, publication_state
         FROM kith.documents WHERE id = $1`,
      [id],
    ),
  );
  const generation = await cached(
    caches.generations,
    chunk.processing_generation_id,
    (id) =>
      row<GenerationRow>(
        ctx,
        `SELECT id, space_id, source_account_id, source_item_id,
                source_revision_id, source_text_version_id, state
           FROM kith.processing_generations WHERE id = $1`,
        [id],
      ),
  );
  const item = await cached(
    caches.items,
    generation?.source_item_id ?? null,
    (id) => loadSourceItem(ctx, id),
  );
  const account = await cached(
    caches.accounts,
    generation?.source_account_id ?? null,
    (id) => loadSourceAccount(ctx, id),
  );
  const revision = await cached(
    caches.revisions,
    generation?.source_revision_id ?? null,
    (id) =>
      row<RevisionRow>(
        ctx,
        "SELECT id, space_id, source_item_id FROM kith.source_revisions WHERE id = $1",
        [id],
      ),
  );
  const textVersion = await cached(
    caches.textVersions,
    generation?.source_text_version_id ?? null,
    (id) =>
      row<TextVersionRow>(
        ctx,
        `SELECT id, space_id, source_revision_id, evidence_sealed
           FROM kith.source_text_versions WHERE id = $1`,
        [id],
      ),
  );
  if (
    !document ||
    !generation ||
    !item ||
    !account ||
    !revision ||
    !textVersion ||
    document.space_id !== spaceId ||
    document.processing_generation_id !== generation.id ||
    document.source_item_id !== item.id ||
    document.source_revision_id !== generation.source_revision_id ||
    document.source_text_version_id !== generation.source_text_version_id ||
    document.publication_state !== "active" ||
    generation.space_id !== spaceId ||
    generation.state !== "ready" ||
    generation.source_account_id !== item.source_account_id ||
    account.space_id !== spaceId ||
    revision.space_id !== spaceId ||
    revision.source_item_id !== item.id ||
    textVersion.space_id !== spaceId ||
    textVersion.source_revision_id !== revision.id ||
    textVersion.evidence_sealed !== true ||
    item.space_id !== spaceId
  ) {
    throw new Error("Active chunk has an invalid processing parent chain");
  }
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    return null;
  }
  if (item.active_generation_id !== generation.id) {
    throw new Error(
      "Active chunk is not in its source item's active generation",
    );
  }
  if (item.active_revision_id !== revision.id) {
    throw new Error("Active chunk is not in its source item's active revision");
  }
  return {
    processingGenerationId: generation.id,
    optedIn: chunkTargetsOptedIn(item, account),
  };
}
