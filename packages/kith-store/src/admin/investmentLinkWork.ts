// `investment_link`: matching as deferred work.
//
// Slice 2 of docs/plans/2026-09-19-investment-document-matching.md. Slice 1
// built the scorer and `evaluateDocumentLinks` (`investmentLinks.ts`) and
// wired nothing to it; this file is the wiring. It holds four things and
// nothing else:
//
//   1. THE KIND. One deferred-work job per DOCUMENT, keyed on its source
//      item. `runInvestmentLinkJob` is what `drain` runs, inside the
//      `SERIALIZABLE` transaction `drain` opens for a transaction-scoped
//      handler. All of the work is database work, so it needs no pooled
//      handler and holds no connection across anything.
//   2. THE TRIGGERS. `scheduleInvestmentLink` and the two fan-outs below are
//      called from the write that caused them, in that write's own
//      transaction, so a job row commits with the change or not at all.
//   3. THE FAN-OUT. An entry or an investment changing means SOME documents
//      may now decide differently. Which ones is a question this file answers
//      with a bounded query, never with "every document in the space".
//   4. THE BACKFILL. The operator route (`investmentLinkCli.ts`) for the 91
//      documents that were extracted before any of this existed.
//
// WHAT IT DOES NOT HOLD. No detector, no attention item, no alert, no log
// line, no model call: those are slices 3 to 7. A job that finds nothing to
// link is a quiet success and writes nothing at all, which is the whole
// reason this can run on every save without becoming noise.
//
// TWO BOUNDS, AND WHY THEY ARE DIFFERENT
//
// The fan-out has two halves and they are not equally important.
//
//   * The MANDATORY half is every document that already holds a link row for
//     the investment. A stale `auto_linked` row is the one failure mode that
//     matters here -- the owner edits an amount, the row that cited the old
//     one keeps standing, and the date it moved stays moved. That is silent
//     wrong data, so this half is never sampled and never truncated. It is
//     naturally small: it is the paper the owner actually has.
//   * The SPECULATIVE half is every extracted document that now matches on
//     party, path or amount and holds no link yet. Missing one of these costs
//     a suggestion that does not appear until the document or the entry is
//     touched again. That is a missing offer, not a wrong fact, so it is
//     bounded and the bound is allowed to bite.
//
// Neither half ever fails the owner's write. An edit that cannot be fanned
// out is still an edit he made.

import type { ClientBase } from "pg";

import {
  schedule,
  TerminalDeferredWorkError,
  type DeferredWorkRow,
  type ScheduleResult,
} from "../deferred/core.js";
import { KITH_ID } from "../ids.js";
import { IdentityError } from "../identity/errors.js";
import type { ObservationValue } from "../records/values.js";
import { evaluateDocumentLinks } from "./investmentLinks.js";
import {
  amountMatches,
  MATCHABLE_DOCUMENT_KINDS,
  matchableKind,
  normalizeMatchName,
  pathNamesFromUri,
} from "./linkScoring.js";
import type { InvestmentEntryType } from "./model.js";

/** `{ client, now }`: the shape both `DeferredCtx` and `IdentityCtx` are, so
 * a trigger can be called from either side without a conversion. */
export type LinkWorkCtx = {
  readonly client: ClientBase;
  readonly now: number;
};

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Observation rows one fan-out reads while deciding which documents a change
 * could affect.
 *
 * It is a bound on the SPECULATIVE half only (see the module comment). The
 * scan is already narrowed to extractions whose kind this scorer has rules
 * for -- a handful of the owner's 91 documents -- so this is the runaway
 * guard, not the working size. If it ever bites, the cost is a suggestion
 * that waits for the next touch of the document itself.
 */
const MAX_LINK_TRIGGER_OBSERVATIONS = 5_000;

/**
 * Documents one fan-out enqueues speculatively. Deliberately at
 * `MAX_LINK_CANDIDATES` (`investmentLinks.ts`): a change that would newly
 * interest more documents than one evaluation may score is a change whose
 * answer is not a bigger queue burst.
 */
const MAX_LINK_TRIGGER_DOCUMENTS = 200;

/** Documents one backfill call enqueues, and its ceiling. */
const DEFAULT_BACKFILL_LIMIT = 200;
const MAX_BACKFILL_LIMIT = 1_000;

/** Every kind the scorer has rules for. A document of any other kind is never
 * enqueued: `evaluateDocumentLinks` would return `kind_not_matchable` without
 * writing anything, so the job would be a queue row that exists to do
 * nothing. */
export const MATCHABLE_KIND_NAMES: readonly string[] = Object.freeze(
  MATCHABLE_DOCUMENT_KINDS.map((kind) => kind.kind),
);

/** The kinds that may be about an entry of this type. A capital call notice
 * never proposes itself against a distribution, so a distribution's edit
 * never wakes one up. */
function kindsForEntryType(entryType: InvestmentEntryType): string[] {
  return MATCHABLE_DOCUMENT_KINDS.filter((kind) =>
    kind.entryTypes.includes(entryType),
  ).map((kind) => kind.kind);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * The plan's `investment_link:item:<sourceItemId>`.
 *
 * ONE JOB PER DOCUMENT, whatever woke it. The entry and investment triggers
 * fan out into per-document jobs rather than carrying an entry id, so a burst
 * of edits -- the drawer saves on every keystroke-sized change, and the
 * screen refreshes underneath it -- collapses onto one queued row per
 * document instead of one per save. `schedule` does the collapsing: a key
 * that already has a `queued` or `running` row is a no-op.
 */
export function investmentLinkDedupeKey(sourceItemId: string): string {
  return `investment_link:item:${sourceItemId}`;
}

/**
 * Enqueues one document's re-evaluation, in the caller's transaction.
 *
 * Call this from inside the write that caused it. The row commits with that
 * write or not at all, which is what stops a job existing for a change that
 * rolled back, and a change existing with no job behind it.
 */
export async function scheduleInvestmentLink(
  ctx: LinkWorkCtx,
  input: { spaceId: string; sourceItemId: string },
): Promise<ScheduleResult> {
  return await schedule(ctx, {
    kind: "investment_link",
    spaceId: input.spaceId,
    payload: { spaceId: input.spaceId, sourceItemId: input.sourceItemId },
    dedupeKey: investmentLinkDedupeKey(input.sourceItemId),
  });
}

/**
 * Trigger 1: a document's extraction was stored or re-stored.
 *
 * Called from `store` in `extraction/model.ts`, in the transaction that
 * replaces the document's statements, so the matcher always sees the reading
 * that has just landed rather than the one before it.
 *
 * Gated on the kind, for the reason `MATCHABLE_KIND_NAMES` gives. A document
 * whose kind CHANGES from a matchable one to another is not covered by this
 * gate and is not covered without it either -- `evaluateDocumentLinks`
 * returns `kind_not_matchable` before it sweeps anything -- so the gate costs
 * nothing that the scorer does not already cost. Slice 3's nightly sweep is
 * where that case belongs.
 */
export async function scheduleInvestmentLinkForExtraction(
  ctx: LinkWorkCtx,
  input: { spaceId: string; sourceItemId: string; kind: string | null },
): Promise<ScheduleResult | null> {
  if (input.kind === null || matchableKind(input.kind) === null) return null;
  return await scheduleInvestmentLink(ctx, input);
}

export type FanOutResult = {
  /** Documents already carrying a link row for this investment. */
  linked: number;
  /** Documents newly interesting on party, path or amount. */
  candidates: number;
  /** Jobs this call inserted. The rest were already queued or running. */
  enqueued: number;
};

/**
 * Trigger 2 and trigger 3: which documents could decide differently now.
 *
 * `entry` narrows the speculative half to the kinds that may be about that
 * entry's type, and adds its amount as a signal. Omitted -- an investment
 * renamed, its signing date moved, an investment archived or restored -- the
 * speculative half is every matchable kind matched on party and path alone.
 *
 * The mandatory half (documents that already hold a link row for this
 * investment) runs either way and is never bounded away.
 */
export async function scheduleInvestmentLinksFor(
  ctx: LinkWorkCtx,
  input: {
    spaceId: string;
    investmentId: string;
    entry?: {
      entryType: InvestmentEntryType;
      amount: string;
      currency: string;
      exchangeRate: string | null;
    };
  },
): Promise<FanOutResult> {
  const kinds =
    input.entry === undefined
      ? [...MATCHABLE_KIND_NAMES]
      : kindsForEntryType(input.entry.entryType);

  const sourceItemIds = new Set<string>();

  // The mandatory half. Every state, including `rejected`: a rejected pair is
  // skipped by the scorer itself, and the same document may hold a live row
  // on another entry of this investment that this change does move.
  const linked = await ctx.client.query<{ source_item_id: string }>(
    `SELECT DISTINCT source_item_id
       FROM kith.investment_document_links
      WHERE space_id = $1 AND investment_id = $2`,
    [input.spaceId, input.investmentId],
  );
  for (const row of linked.rows) sourceItemIds.add(row.source_item_id);
  const linkedCount = sourceItemIds.size;

  // The speculative half.
  const names = await investmentMatchNames(
    ctx,
    input.spaceId,
    input.investmentId,
  );
  let candidates = 0;
  if (kinds.length > 0 && (names.length > 0 || input.entry !== undefined)) {
    for (const found of await scanMatchableDocuments(ctx, input.spaceId, kinds)) {
      if (sourceItemIds.size >= MAX_LINK_TRIGGER_DOCUMENTS + linkedCount) break;
      if (sourceItemIds.has(found.sourceItemId)) continue;
      if (!documentCouldMatch(found, names, input.entry)) continue;
      sourceItemIds.add(found.sourceItemId);
      candidates += 1;
    }
  }

  let enqueued = 0;
  for (const sourceItemId of sourceItemIds) {
    const result = await scheduleInvestmentLink(ctx, {
      spaceId: input.spaceId,
      sourceItemId,
    });
    if (!result.deduped) enqueued += 1;
  }
  return { linked: linkedCount, candidates, enqueued };
}

/** The same fan-out, starting from an entry id. Reads the entry's own type,
 * amount, currency and rate as they stand AFTER the write that called this. */
export async function scheduleInvestmentLinksForEntry(
  ctx: LinkWorkCtx,
  input: { spaceId: string; entryId: string },
): Promise<FanOutResult | null> {
  const entry = await ctx.client.query<{
    investment_id: string;
    entry_type: string;
    amount: string;
    currency: string;
    exchange_rate: string | null;
  }>(
    `SELECT investment_id, entry_type, amount, currency, exchange_rate
       FROM kith.investment_entries
      WHERE id = $1 AND space_id = $2`,
    [input.entryId, input.spaceId],
  );
  const record = entry.rows[0];
  if (!record) return null;
  return await scheduleInvestmentLinksFor(ctx, {
    spaceId: input.spaceId,
    investmentId: record.investment_id,
    entry: {
      entryType: record.entry_type as InvestmentEntryType,
      amount: record.amount,
      currency: record.currency,
      exchangeRate: record.exchange_rate,
    },
  });
}

/**
 * Every document already linked to one entry, enqueued before that entry goes
 * away.
 *
 * A deleted entry takes its link rows with it (`ON DELETE CASCADE`, migration
 * 033), so after the delete there is nothing left to say which documents were
 * about it. Collected first, they get one more pass against the entries that
 * remain.
 */
export async function scheduleInvestmentLinksForEntryDocuments(
  ctx: LinkWorkCtx,
  input: { spaceId: string; entryId: string },
): Promise<number> {
  const found = await ctx.client.query<{ source_item_id: string }>(
    `SELECT DISTINCT source_item_id
       FROM kith.investment_document_links
      WHERE space_id = $1 AND entry_id = $2`,
    [input.spaceId, input.entryId],
  );
  let enqueued = 0;
  for (const row of found.rows) {
    const result = await scheduleInvestmentLink(ctx, {
      spaceId: input.spaceId,
      sourceItemId: row.source_item_id,
    });
    if (!result.deduped) enqueued += 1;
  }
  return enqueued;
}

// ---------------------------------------------------------------------------
// Which documents a change could reach
// ---------------------------------------------------------------------------

/** The investment's own name and its entity's aliases, normalized the way the
 * scorer compares them. The same two sources `loadInvestmentNames` reads, for
 * one investment rather than the space. */
async function investmentMatchNames(
  ctx: LinkWorkCtx,
  spaceId: string,
  investmentId: string,
): Promise<string[]> {
  const found = await ctx.client.query<{
    name: string;
    normalized_aliases: unknown;
  }>(
    `SELECT i.name, e.normalized_aliases
       FROM kith.investments i
       LEFT JOIN kith.entities e
         ON e.id = i.entity_id AND e.space_id = i.space_id
      WHERE i.id = $1 AND i.space_id = $2`,
    [investmentId, spaceId],
  );
  const record = found.rows[0];
  if (!record) return [];
  const names = new Set<string>();
  const own = normalizeMatchName(record.name);
  if (own) names.add(own);
  if (Array.isArray(record.normalized_aliases)) {
    for (const alias of record.normalized_aliases) {
      const normalized = normalizeMatchName(alias);
      if (normalized) names.add(normalized);
    }
  }
  return [...names];
}

type ScannedDocument = {
  sourceItemId: string;
  uri: string | null;
  values: ObservationValue[];
};

/**
 * The extracted documents of these kinds in this space, with their URI and
 * their current statement values.
 *
 * Deliberately NOT filtered in SQL. Party matching is `normalizeMatchName`
 * and amount matching is `amountMatches`, both of which are the scorer's own
 * functions over BigInt arithmetic and Unicode folding. Re-expressing either
 * in SQL would be a second implementation of the rule that decides where the
 * owner's money is filed, and the two would drift. The filter is in
 * JavaScript, against the same code the evaluation itself uses, and the SQL
 * does the one thing SQL is needed for: narrowing to this space and to kinds
 * the scorer has rules for.
 *
 * ORDER BY is on the source item so a truncated scan truncates the same way
 * twice, rather than sampling differently on every save.
 */
async function scanMatchableDocuments(
  ctx: LinkWorkCtx,
  spaceId: string,
  kinds: readonly string[],
): Promise<ScannedDocument[]> {
  const found = await ctx.client.query<{
    source_item_id: string;
    uri: string | null;
    value: unknown;
  }>(
    `SELECT e.source_item_id, i.uri, o.value
       FROM kith.document_extractions e
       JOIN kith.source_items i
         ON i.id = e.source_item_id AND i.space_id = e.space_id
       LEFT JOIN kith.observations o
         ON o.space_id = e.space_id AND o.event_id = e.event_id
        AND o.event_type = 'document_statement'
      WHERE e.space_id = $1 AND e.kind = ANY($2::text[])
      ORDER BY e.source_item_id, o.observation_key
      LIMIT $3`,
    [spaceId, [...kinds], MAX_LINK_TRIGGER_OBSERVATIONS],
  );
  const byItem = new Map<string, ScannedDocument>();
  for (const row of found.rows) {
    let document = byItem.get(row.source_item_id);
    if (!document) {
      document = { sourceItemId: row.source_item_id, uri: row.uri, values: [] };
      byItem.set(row.source_item_id, document);
    }
    if (row.value !== null && typeof row.value === "object") {
      document.values.push(row.value as ObservationValue);
    }
  }
  return [...byItem.values()];
}

/**
 * Whether this document is worth waking up for this change.
 *
 * Over-answering is cheap and under-answering is not: an extra job re-reaches
 * the same decision and writes nothing (`evaluateDocumentLinks` compares
 * before it writes), while a missed one leaves an offer unmade. So a text
 * value matching a name is enough, without checking that the statement was an
 * `organization` -- the value type lives in the extraction's `statements`
 * JSON rather than on the observation, and the evaluation itself is where
 * that distinction is enforced.
 */
function documentCouldMatch(
  document: ScannedDocument,
  names: readonly string[],
  entry:
    | {
        amount: string;
        currency: string;
        exchangeRate: string | null;
      }
    | undefined,
): boolean {
  if (names.length > 0) {
    for (const name of pathNamesFromUri(document.uri)) {
      if (names.includes(name)) return true;
    }
    for (const value of document.values) {
      if (value.type !== "text") continue;
      const normalized = normalizeMatchName(value.value);
      if (normalized && names.includes(normalized)) return true;
    }
  }
  if (entry === undefined) return false;
  for (const value of document.values) {
    if (value.type !== "money") continue;
    const matched = amountMatches({
      documentAmount: value.amount,
      documentCurrency: value.currency,
      entryAmount: entry.amount,
      entryCurrency: entry.currency,
      entryExchangeRate: entry.exchangeRate,
    });
    if (matched.matched) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * The `investment_link` handler body.
 *
 * One document, one space, one call to `evaluateDocumentLinks` inside the
 * `SERIALIZABLE` transaction `drain` opened for it. Nothing else: the
 * evaluation decides, writes only what changed, and returns.
 *
 * IDEMPOTENT. Running it twice over an unchanged database writes nothing the
 * second time. That is slice 1's guarantee, not a claim made here -- the link
 * upsert's `ON CONFLICT ... DO UPDATE` requires a stored column to differ and
 * `syncEntryDocument` reads the mirror before writing it -- and the test that
 * holds it is the one that drains twice and asserts `kith.changes` has not
 * grown.
 *
 * FAILURE MODES, all three of them:
 *
 *   * A payload of the wrong shape, or a payload naming a space the job row
 *     does not (`job.spaceId`), is terminal. No retry can repair either, and
 *     the second is the cross-space guard: a job carries one space and this
 *     handler reads one space.
 *   * A bound the scorer refuses to score past -- `candidate_limit` or
 *     `investment_limit` -- is terminal too. The scorer throws those rather
 *     than scoring a prefix, because a prefix is a different decision; the
 *     queue's answer to that is a recorded `failed` row an operator can read,
 *     not five identical attempts spread over fifteen minutes.
 *   * Everything else -- a serialization failure past its retries, a lost
 *     connection, a bug -- is an ordinary throw, and `fail`'s bounded backoff
 *     is right for all of it.
 *
 * QUIET. A document with no extraction, of a kind the scorer has no rules
 * for, or matching no investment is a plain success that writes nothing and
 * says nothing. The owner has 142 entries with no paper on them; a job per
 * document that announced "found nothing" would be the noise this whole
 * design treats as a defect.
 */
export async function runInvestmentLinkJob(
  ctx: LinkWorkCtx,
  payload: Record<string, unknown>,
  job: DeferredWorkRow,
): Promise<void> {
  const spaceId = payload.spaceId;
  const sourceItemId = payload.sourceItemId;
  if (
    typeof spaceId !== "string" ||
    !KITH_ID.test(spaceId) ||
    typeof sourceItemId !== "string" ||
    !KITH_ID.test(sourceItemId)
  ) {
    throw new TerminalDeferredWorkError(
      "investment_link payload requires spaceId and sourceItemId",
    );
  }
  if (job.spaceId !== null && job.spaceId !== spaceId) {
    throw new TerminalDeferredWorkError(
      "investment_link payload is not in the job's space",
    );
  }
  try {
    await evaluateDocumentLinks(ctx, { spaceId, sourceItemId });
  } catch (error) {
    if (
      error instanceof IdentityError &&
      (error.data?.code === "candidate_limit" ||
        error.data?.code === "investment_limit")
    ) {
      throw new TerminalDeferredWorkError(
        `investment_link stopped at a bound: ${error.data.code}`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

export type LinkBackfillResult = {
  /** Extracted documents of matchable kinds this call looked at. */
  considered: number;
  /** Of those, the ones that already have a `queued` or `running` job. */
  alreadyQueued: number;
  /** Jobs this call would enqueue, and did when `apply` was set. */
  enqueued: number;
};

/**
 * Every extracted document of a kind the scorer names, enqueued once.
 *
 * `apply` defaults to false: the operator route (`investmentLinkCli.ts`) is a
 * dry run until it is told otherwise, the same way `kith-extraction-backfill`
 * is. The dry run counts exactly what the apply would insert, because both
 * read the same two queries and the only difference is whether `schedule`
 * runs.
 *
 * IT NEVER EVALUATES INLINE. The backfill's job is to put rows in the queue;
 * the daemon drains them at its own pace under its own bounds. An operator
 * command that scored 91 documents in one transaction would hold a
 * connection for as long as the slowest of them and would have no lease to
 * recover from if it died halfway.
 */
export async function scheduleInvestmentLinkBackfill(
  ctx: LinkWorkCtx,
  input: {
    spaceId: string;
    kind?: string;
    limit?: number;
    apply?: boolean;
  },
): Promise<LinkBackfillResult> {
  const limit = Math.min(
    Math.max(input.limit ?? DEFAULT_BACKFILL_LIMIT, 1),
    MAX_BACKFILL_LIMIT,
  );
  const kinds =
    input.kind === undefined ? [...MATCHABLE_KIND_NAMES] : [input.kind];
  const found = await ctx.client.query<{ source_item_id: string }>(
    `SELECT source_item_id FROM kith.document_extractions
      WHERE space_id = $1 AND kind = ANY($2::text[])
      ORDER BY source_item_id
      LIMIT $3`,
    [input.spaceId, kinds, limit],
  );
  const sourceItemIds = found.rows.map((row) => row.source_item_id);
  if (sourceItemIds.length === 0) {
    return { considered: 0, alreadyQueued: 0, enqueued: 0 };
  }
  const queued = await ctx.client.query<{ dedupe_key: string }>(
    `SELECT dedupe_key FROM kith.deferred_work
      WHERE kind = 'investment_link' AND state IN ('queued', 'running')
        AND dedupe_key = ANY($1::text[])`,
    [sourceItemIds.map(investmentLinkDedupeKey)],
  );
  const alreadyQueued = new Set(queued.rows.map((row) => row.dedupe_key));
  const result: LinkBackfillResult = {
    considered: sourceItemIds.length,
    alreadyQueued: alreadyQueued.size,
    enqueued: sourceItemIds.length - alreadyQueued.size,
  };
  if (input.apply !== true) return result;
  let enqueued = 0;
  for (const sourceItemId of sourceItemIds) {
    const scheduled = await scheduleInvestmentLink(ctx, {
      spaceId: input.spaceId,
      sourceItemId,
    });
    if (!scheduled.deduped) enqueued += 1;
  }
  // The read above and this loop are in one transaction, so they agree; the
  // count is re-reported from what actually inserted rather than from the
  // prediction, because the two disagreeing would be worth knowing about.
  return { ...result, enqueued };
}
