// The documents the Edit investment drawer lists: every paper linked to the
// investment, at the investment level or through one of its entries.
//
// A read over `kith.investment_document_links`, which stays the source of
// truth (see `investmentLinks.ts`). One row per source item: a document can be
// linked to the investment and to one of its entries at once, and the owner
// reads that as one document. Rejected links are left out; they exist only so
// the scorer never proposes the pair again.

import { type IdentityCtx, rows } from "../identity/db.js";
import { assertKithId } from "../ids.js";
import { spacePredicate } from "../spaces.js";
import type { LinkState } from "./investmentLinks.js";

/** An investment has tens of documents. The bound is for a runaway read. */
const MAX_INVESTMENT_DOCUMENTS = 200;

export type InvestmentDocument = {
  /** The link the drawer's Confirm and Remove act on. For a document linked
   * more than once, the strongest one: confirmed, then auto-linked, then
   * suggested. */
  linkId: string;
  sourceItemId: string;
  title: string | null;
  /** The extraction's kind (`investment_agreement`, `schedule_k1`, ...), or
   * null when the document has not been read. */
  kind: string | null;
  state: Exclude<LinkState, "rejected">;
  /** The entry the link names, or null for an investment-level link. */
  entryId: string | null;
  /** When the document was captured, epoch milliseconds, or null. */
  capturedAt: number | null;
  /** `kith.source_items.uri` (`fs://<root alias>/<path>`). Server-side use
   * only: the upload route files a new document beside the existing ones. */
  uri: string | null;
};

export async function listInvestmentDocuments(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  investmentId: string,
): Promise<InvestmentDocument[]> {
  const predicate = spacePredicate(spaceIds, 1, "l.space_id");
  const records = await rows<{
    id: string;
    source_item_id: string;
    state: string;
    entry_id: string | null;
    title: string | null;
    kind: string | null;
    captured_at: Date | null;
    uri: string | null;
  }>(
    ctx,
    `SELECT DISTINCT ON (l.source_item_id)
            l.id, l.source_item_id, l.state, l.entry_id,
            d.title, x.kind, d.captured_at, s.uri
       FROM kith.investment_document_links l
       LEFT JOIN kith.source_items s
         ON s.id = l.source_item_id AND s.space_id = l.space_id
       LEFT JOIN LATERAL (
         SELECT title, captured_at FROM kith.documents
          WHERE source_item_id = l.source_item_id AND space_id = l.space_id
            AND publication_state = 'active'
          ORDER BY captured_at DESC LIMIT 1) d ON true
       LEFT JOIN LATERAL (
         SELECT kind FROM kith.document_extractions
          WHERE source_item_id = l.source_item_id AND space_id = l.space_id
          ORDER BY created_at DESC LIMIT 1) x ON true
      WHERE ${predicate.sql}
        AND l.investment_id = $2
        AND l.state <> 'rejected'
      ORDER BY l.source_item_id,
               CASE l.state WHEN 'confirmed' THEN 0
                            WHEN 'auto_linked' THEN 1 ELSE 2 END,
               (l.entry_id IS NULL) DESC, l.created_at
      LIMIT $3`,
    [
      predicate.value,
      assertKithId(investmentId, "invalid_investment_id"),
      MAX_INVESTMENT_DOCUMENTS,
    ],
  );
  return records
    .map((record) => ({
      linkId: record.id,
      sourceItemId: record.source_item_id,
      title: record.title,
      kind: record.kind,
      state: record.state as InvestmentDocument["state"],
      entryId: record.entry_id,
      capturedAt: record.captured_at?.getTime() ?? null,
      uri: record.uri,
    }))
    .sort(
      (left, right) =>
        (right.capturedAt ?? 0) - (left.capturedAt ?? 0) ||
        left.sourceItemId.localeCompare(right.sourceItemId),
    );
}
