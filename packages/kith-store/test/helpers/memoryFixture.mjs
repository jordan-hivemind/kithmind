// Shared fixtures for the memory domain tests (P2-39h), built on the identity
// fixture's migrated throwaway database and synthetic rows.

import { identityDatabase, makeMember, makeSpace, makeUser, skip } from "./identityFixture.mjs";

export { identityDatabase, makeMember, makeSpace, makeUser, skip };

/**
 * The deterministic fake standing in for P2-39g's real index: ranks facts and
 * thoughts in one space set by a plain case-insensitive substring match
 * against `search_text` / `content`, newest first. It is not trying to be
 * `tsvector` ranking -- it exists only to prove `recallContext`'s contract
 * (authorize, hydrate, preserve order) against *some* ranked candidate list,
 * exactly as the module comment on `recall.ts` describes.
 */
export async function recallCandidates(ctx, spaceIds, query, limit = 10) {
  if (spaceIds.length === 0) return { factIds: [], thoughtIds: [] };
  const pattern = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const facts = (
    await ctx.client.query(
      `SELECT id FROM kith.facts
        WHERE space_id = ANY($1::text[]) AND search_text ILIKE $2
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [spaceIds, pattern, limit],
    )
  ).rows.map((row) => row.id);
  const thoughts = (
    await ctx.client.query(
      `SELECT id FROM kith.thoughts
        WHERE space_id = ANY($1::text[]) AND content ILIKE $2
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [spaceIds, pattern, limit],
    )
  ).rows.map((row) => row.id);
  return { factIds: facts, thoughtIds: thoughts };
}
