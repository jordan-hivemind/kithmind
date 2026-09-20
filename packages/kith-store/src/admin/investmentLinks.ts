// `kith.investment_document_links`: the reading, the writing, and the one rule
// that moves a financial date.
//
// Slices 1 and 1b of docs/plans/2026-09-19-investment-document-matching.md.
// `linkScoring.ts` decides; this file gathers what it decides from and stores
// what it decided. Nothing here schedules anything: the deferred kind, the
// three triggers and the nightly sweep are slice 2, and `evaluateDocumentLinks`
// is written to be the function that slice calls.
//
// THE SOURCE OF TRUTH IS THIS TABLE.
//
// `investment_entries.document_id` keeps the meaning it has had since
// migration 022 -- the entry's primary citation, read by the totals, the
// screen and `get_investment` -- but it is now derived. It holds the document
// of the entry's one LIVE link (`auto_linked` or `confirmed`) and nothing
// else, and `syncEntryDocument` below is the only thing that writes it. Every
// path that used to set it directly, including the drawer's "attach this
// document", now writes a link and lets the sync follow, in the same
// transaction. Two things stop the two from disagreeing:
//
//   * `investment_document_links_entry_live_idx` (migration 033) allows at
//     most one live link per entry, so "the entry's document" is always one
//     well-defined row rather than a choice among several.
//   * Every exported write below calls `syncEntryDocument` for every entry it
//     touched, in its own transaction. `test/investmentLinks.test.mjs` runs a
//     whole-table consistency query after each transition and fails if any
//     entry's `document_id` is not what its links say it should be.
//
// SPACE ISOLATION. Every statement filters on `space_id`, and the table's
// composite foreign keys onto `(id, space_id)` mean the server itself refuses
// a link between two spaces. A caller that hands this file a source item from
// another space gets nothing back, not another household's investments.
//
// MONEY. Not one amount in this file becomes a JavaScript number. Amounts
// arrive from `numeric` as strings and are compared in `linkScoring.ts` with
// BigInt arithmetic.

import {
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import { exec, type IdentityCtx, row, rows } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId, newKithId } from "../ids.js";
import type { ObservationValue } from "../records/values.js";
import { spacePredicate } from "../spaces.js";
import {
  dateInWindow,
  decideLinks,
  type LinkEvidence,
  type LinkSignalRecord,
  matchableKind,
  normalizeMatchName,
  pathNamesFromUri,
  scoreCandidate,
  type ScorableEntry,
  type ScorableStatement,
  type ScoredCandidate,
} from "./linkScoring.js";
import type { InvestmentEntryType } from "./model.js";

// ---------------------------------------------------------------------------
// Bounds and vocabulary
// ---------------------------------------------------------------------------

/** Investments one evaluation loads to match a document's parties against.
 * The owner tracks about 39; the bound is for a runaway read. */
const MAX_LINK_INVESTMENTS = 500;

/** Entries one evaluation scores. Beyond this the pass refuses rather than
 * silently scoring a prefix, because a prefix is a different decision. */
const MAX_LINK_CANDIDATES = 200;

/** Suggestions one document may offer at once. */
const MAX_LINK_SUGGESTIONS = 10;

/** Statements one document's extraction may carry into the scorer. */
const MAX_LINK_STATEMENTS = 512;

export const LINK_STATES = [
  "auto_linked",
  "suggested",
  "confirmed",
  "rejected",
] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const LINK_DECIDERS = ["rule", "model", "owner"] as const;
export type LinkDecider = (typeof LINK_DECIDERS)[number];

/** The states that put a document on an entry. At most one per entry. */
const LIVE_STATES: readonly LinkState[] = ["auto_linked", "confirmed"];

/** `kith.corrections.detector` for a date this feature moved. */
export const LINK_DATE_DETECTOR = "investment_link_date";

export type InvestmentDocumentLink = {
  id: string;
  spaceId: string;
  investmentId: string;
  entryId: string | null;
  documentId: string | null;
  sourceItemId: string;
  state: LinkState;
  score: number;
  signals: LinkSignalRecord[];
  evidence: LinkEvidence[];
  decidedBy: LinkDecider;
  decidedAt: number;
  actorUserId: string | null;
  model: string | null;
  reason: string;
  /** The `kith.corrections` row recording this link's replacement of an
   * estimated entry date, when it made one. */
  dateCorrectionId: string | null;
  createdAt: number;
};

function typedError(code: string, message: string): never {
  throw new IdentityError(message, { code, message });
}

/** Bare and non-enumerating, like every other denial in `admin/`. */
function linkNotFound(): never {
  throw new IdentityError("Investment document link not found");
}

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** `date` comes back from node-pg as a `Date` in the server's zone; the column
 * holds a calendar date and every rule here is about that date. */
function calendarDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type LinkDbRow = {
  id: string;
  space_id: string;
  investment_id: string;
  entry_id: string | null;
  document_id: string | null;
  source_item_id: string;
  state: string;
  score: number;
  signals: unknown;
  evidence: unknown;
  decided_by: string;
  decided_at: Date;
  actor_user_id: string | null;
  model: string | null;
  reason: string;
  date_correction_id: string | null;
  created_at: Date;
};

const LINK_COLUMNS = `id, space_id, investment_id, entry_id, document_id,
  source_item_id, state, score, signals, evidence, decided_by, decided_at,
  actor_user_id, model, reason, date_correction_id, created_at`;

function toLink(record: LinkDbRow): InvestmentDocumentLink {
  return {
    id: record.id,
    spaceId: record.space_id,
    investmentId: record.investment_id,
    entryId: record.entry_id,
    documentId: record.document_id,
    sourceItemId: record.source_item_id,
    state: record.state as LinkState,
    score: Number(record.score),
    signals: (record.signals ?? []) as LinkSignalRecord[],
    evidence: (record.evidence ?? []) as LinkEvidence[],
    decidedBy: record.decided_by as LinkDecider,
    decidedAt: epoch(record.decided_at),
    actorUserId: record.actor_user_id,
    model: record.model,
    reason: record.reason,
    dateCorrectionId: record.date_correction_id,
    createdAt: epoch(record.created_at),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Links in the caller's spaces, filtered by investment, entry or source item.
 *
 * Takes an already-resolved space set, the way `listInvestments` does and for
 * the same reason: the admin screen and an MCP read resolve "who may see
 * this" differently and neither should be chosen here.
 */
export async function listInvestmentDocumentLinks(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  filters: {
    investmentIds?: readonly string[];
    entryIds?: readonly string[];
    sourceItemId?: string;
    states?: readonly LinkState[];
  } = {},
): Promise<InvestmentDocumentLink[]> {
  const predicate = spacePredicate(spaceIds, 1);
  const values: unknown[] = [predicate.value];
  const clauses: string[] = [predicate.sql];
  if (filters.investmentIds !== undefined) {
    values.push(
      filters.investmentIds.map((id) =>
        assertKithId(id, "invalid_investment_id"),
      ),
    );
    clauses.push(`investment_id = ANY($${values.length}::text[])`);
  }
  if (filters.entryIds !== undefined) {
    values.push(
      filters.entryIds.map((id) => assertKithId(id, "invalid_entry_id")),
    );
    clauses.push(`entry_id = ANY($${values.length}::text[])`);
  }
  if (filters.sourceItemId !== undefined) {
    values.push(assertKithId(filters.sourceItemId, "invalid_source_item_id"));
    clauses.push(`source_item_id = $${values.length}`);
  }
  if (filters.states !== undefined) {
    values.push([...filters.states]);
    clauses.push(`state = ANY($${values.length}::text[])`);
  }
  values.push(MAX_LINK_CANDIDATES + MAX_LINK_SUGGESTIONS);
  const records = await rows<LinkDbRow>(
    ctx,
    `SELECT ${LINK_COLUMNS} FROM kith.investment_document_links
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id
      LIMIT $${values.length}`,
    values,
  );
  return records.map(toLink);
}

// ---------------------------------------------------------------------------
// Gathering what the scorer decides from
// ---------------------------------------------------------------------------

type ExtractionRead = {
  kind: string;
  statements: ScorableStatement[];
};

type StoredStatementShape = {
  field?: unknown;
  valueType?: unknown;
  observationKeys?: unknown;
  evidenceSpanId?: unknown;
};

/**
 * One document's typed statements, with the CURRENT value of each.
 *
 * The value comes from `kith.observations` rather than from the extraction
 * row's own `modelValue`, because a resolved correction is written through to
 * the observation (`src/extraction/corrections.ts`, `writeThrough`). So a
 * reading the owner fixed is what the scorer matches on, which is the plan's
 * "a corrected amount turns into a clean link".
 *
 * A statement with several observation keys is a `line_item_list`. It is
 * skipped: no party, amount or date signal is ever a list, and a list value
 * would need a key per line to cite.
 */
async function readExtraction(
  ctx: IdentityCtx,
  spaceId: string,
  sourceItemId: string,
): Promise<ExtractionRead | null> {
  const record = await row<{
    kind: string;
    statements: unknown;
    event_id: string | null;
  }>(
    ctx,
    `SELECT kind, statements, event_id FROM kith.document_extractions
      WHERE space_id = $1 AND source_item_id = $2 LIMIT 1`,
    [spaceId, sourceItemId],
  );
  if (!record) return null;
  const values = new Map<string, ObservationValue>();
  if (record.event_id !== null) {
    const observations = await rows<{ observation_key: string; value: unknown }>(
      ctx,
      `SELECT observation_key, value FROM kith.observations
        WHERE space_id = $1 AND event_id = $2
          AND event_type = 'document_statement'
        LIMIT $3`,
      [spaceId, record.event_id, MAX_LINK_STATEMENTS],
    );
    for (const observation of observations) {
      values.set(observation.observation_key, observation.value as ObservationValue);
    }
  }
  const stored = Array.isArray(record.statements)
    ? (record.statements as StoredStatementShape[])
    : [];
  const statements: ScorableStatement[] = [];
  for (const statement of stored.slice(0, MAX_LINK_STATEMENTS)) {
    const keys = statement.observationKeys;
    if (
      typeof statement.field !== "string" ||
      typeof statement.valueType !== "string" ||
      typeof statement.evidenceSpanId !== "string" ||
      !Array.isArray(keys) ||
      keys.length !== 1 ||
      typeof keys[0] !== "string"
    ) {
      continue;
    }
    statements.push({
      field: statement.field,
      valueType: statement.valueType,
      observationKey: keys[0],
      evidenceSpanId: statement.evidenceSpanId,
      value: values.get(keys[0]) ?? null,
    });
  }
  return { kind: record.kind, statements };
}

type InvestmentNames = {
  id: string;
  signedOn: string | null;
  normalizedNames: string[];
};

/**
 * Every investment in the space with its name and its entity's aliases,
 * normalized the way the scorer compares them.
 *
 * Aliases are `kith.entities.normalized_aliases`, reached through
 * `investments.entity_id` -- the plan's "no alias table is added". An
 * investment with no entity matches on its own name alone, which is what the
 * owner's imported rows look like until he binds one.
 *
 * Archived investments are excluded: a document must not link itself to an
 * investment the owner has put away.
 */
async function loadInvestmentNames(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<InvestmentNames[]> {
  const records = await rows<{
    id: string;
    name: string;
    signed_on: Date | null;
    normalized_aliases: unknown;
  }>(
    ctx,
    `SELECT i.id, i.name, i.signed_on, e.normalized_aliases
       FROM kith.investments i
       LEFT JOIN kith.entities e
         ON e.id = i.entity_id AND e.space_id = i.space_id
      WHERE i.space_id = $1 AND i.archived_at IS NULL
      ORDER BY i.name, i.id
      LIMIT $2`,
    [spaceId, MAX_LINK_INVESTMENTS + 1],
  );
  if (records.length > MAX_LINK_INVESTMENTS) {
    typedError(
      "investment_limit",
      "Too many investments in this space to match a document against",
    );
  }
  return records.map((record) => {
    const names = new Set<string>();
    const own = normalizeMatchName(record.name);
    if (own) names.add(own);
    if (Array.isArray(record.normalized_aliases)) {
      for (const alias of record.normalized_aliases) {
        const normalized = normalizeMatchName(alias);
        if (normalized) names.add(normalized);
      }
    }
    return {
      id: record.id,
      signedOn: calendarDate(record.signed_on),
      normalizedNames: [...names],
    };
  });
}

type EntryDbRow = {
  id: string;
  investment_id: string;
  entry_type: string;
  entry_date: Date | string;
  amount: string;
  currency: string;
  exchange_rate: string | null;
  date_is_estimated: boolean;
};

function toScorableEntry(
  record: EntryDbRow,
  liveElsewhere: ReadonlySet<string>,
): ScorableEntry {
  return {
    id: record.id,
    investmentId: record.investment_id,
    entryType: record.entry_type as InvestmentEntryType,
    entryDate: calendarDate(record.entry_date)!,
    amount: record.amount,
    currency: record.currency,
    exchangeRate: record.exchange_rate,
    dateIsEstimated: record.date_is_estimated,
    hasLiveLink: liveElsewhere.has(record.id),
  };
}

// ---------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------

export type EvaluateLinksResult = {
  /** False when there was nothing to score. `reason` says why. */
  evaluated: boolean;
  reason:
    | "scored"
    | "no_extraction"
    | "kind_not_matchable"
    | "no_investment_matched"
    | "document_missing";
  kind: string | null;
  autoLinkedEntryId: string | null;
  suggestedCount: number;
  /** Entries whose estimated date this pass replaced. */
  datesReplaced: string[];
};

/**
 * Score one document against the space's investments and store what it
 * decided. Deterministic: the same database state produces the same rows.
 *
 * Takes a `spaceId` rather than a principal because slice 2 calls it from a
 * deferred handler, which has no user. It is not an authorization boundary --
 * the caller resolved the space -- and it writes nothing outside that space.
 *
 * What it writes:
 *
 *   * The one `auto_linked` row, when section 2's conditions all hold.
 *   * A `suggested` row per candidate at or above the threshold.
 *   * Nothing at all for a pair the owner already `confirmed` or `rejected`.
 *     A rejection is remembered forever; that is the whole point of keeping
 *     the row.
 *   * It removes `suggested` rows this document had that this pass no longer
 *     produces, so a corrected document does not leave last week's wrong
 *     offer sitting in the drawer.
 */
export async function evaluateDocumentLinks(
  ctx: IdentityCtx,
  args: { spaceId: string; sourceItemId: string },
): Promise<EvaluateLinksResult> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  const sourceItemId = assertKithId(args.sourceItemId, "invalid_source_item_id");
  const none = (reason: EvaluateLinksResult["reason"], kind: string | null) => ({
    evaluated: false,
    reason,
    kind,
    autoLinkedEntryId: null,
    suggestedCount: 0,
    datesReplaced: [],
  });

  const extraction = await readExtraction(ctx, spaceId, sourceItemId);
  if (!extraction) return none("no_extraction", null);
  const kind = matchableKind(extraction.kind);
  if (!kind) return none("kind_not_matchable", extraction.kind);

  const item = await row<{ uri: string | null }>(
    ctx,
    `SELECT uri FROM kith.source_items WHERE id = $1 AND space_id = $2`,
    [sourceItemId, spaceId],
  );
  if (!item) return none("document_missing", extraction.kind);
  // The document this source item currently publishes. Null is not a failure:
  // a re-parse can leave the source item between generations, and the link's
  // durable identity is the source item, not the document row.
  const document = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.documents
      WHERE space_id = $1 AND source_item_id = $2 AND publication_state = 'active'
      ORDER BY created_at DESC, id LIMIT 1`,
    [spaceId, sourceItemId],
  );

  const pathNames = pathNamesFromUri(item.uri);
  const organizationNames = new Set<string>();
  for (const statement of extraction.statements) {
    if (statement.valueType !== "organization") continue;
    if (!statement.value || statement.value.type !== "text") continue;
    const normalized = normalizeMatchName(statement.value.value);
    if (normalized) organizationNames.add(normalized);
  }

  const investments = await loadInvestmentNames(ctx, spaceId);
  const matched = investments.filter((investment) =>
    investment.normalizedNames.some(
      (name) => organizationNames.has(name) || pathNames.includes(name),
    ),
  );

  // Existing rows for this document: what has already been decided about it.
  const existing = await rows<LinkDbRow>(
    ctx,
    `SELECT ${LINK_COLUMNS} FROM kith.investment_document_links
      WHERE space_id = $1 AND source_item_id = $2
      LIMIT $3`,
    [spaceId, sourceItemId, MAX_LINK_CANDIDATES + MAX_LINK_SUGGESTIONS],
  );
  const pairKey = (investmentId: string, entryId: string | null) =>
    `${investmentId}\u0000${entryId ?? ""}`;
  /** Pairs the owner has already settled. The rule never revisits either: a
   * `rejected` pair is the remembered rejection, and a `confirmed` pair is a
   * human decision a rule does not get to restate. */
  const settled = new Set(
    existing
      .filter((link) => link.state === "rejected" || link.state === "confirmed")
      .map((link) => pairKey(link.investment_id, link.entry_id)),
  );

  const entryTypes = kind.entryTypes;
  let entryRecords: EntryDbRow[] = [];
  if (entryTypes.length > 0) {
    const investmentIds = matched.map((investment) => investment.id);
    // Two candidate sources, unioned:
    //
    //   * every entry of an investment the document named, of a type this
    //     kind can be about; and
    //   * every entry in the space, of such a type, whose amount and currency
    //     are exactly a value this kind's money field states.
    //
    // The second is what lets a document that names no investment the owner
    // recognises still be offered against the payment it matches -- section
    // 2's "amount alone is 4 points". It is exact and same-currency by
    // design: a cross-currency candidate needs the entry's own rate, and
    // scanning every entry in the space converting each one is a different
    // and much more expensive query for a case the party signal already
    // covers.
    const amounts: string[] = [];
    if (kind.amountField !== null) {
      for (const statement of extraction.statements) {
        if (statement.field !== kind.amountField) continue;
        if (!statement.value || statement.value.type !== "money") continue;
        amounts.push(statement.value.amount);
      }
    }
    entryRecords = await rows<EntryDbRow>(
      ctx,
      `SELECT id, investment_id, entry_type, entry_date, amount, currency,
              exchange_rate, date_is_estimated
         FROM kith.investment_entries
        WHERE space_id = $1
          AND entry_type = ANY($2::text[])
          AND (investment_id = ANY($3::text[])
               OR ($4::numeric[] IS NOT NULL AND abs(amount) = ANY($4::numeric[])))
        ORDER BY entry_date, id
        LIMIT $5`,
      [
        spaceId,
        [...entryTypes],
        investmentIds,
        amounts.length > 0 ? amounts : null,
        MAX_LINK_CANDIDATES + 1,
      ],
    );
    if (entryRecords.length > MAX_LINK_CANDIDATES) {
      typedError(
        "candidate_limit",
        "Too many candidate entries for one document; narrow the investment first",
      );
    }
  }

  if (matched.length === 0 && entryRecords.length === 0) {
    return none("no_investment_matched", extraction.kind);
  }

  // Which candidate entries already carry a live link from ANOTHER document.
  // From another: re-evaluating the same document must keep its own auto-link
  // rather than read it as "this entry is taken" and downgrade it.
  const entryIds = entryRecords.map((record) => record.id);
  const liveElsewhere = new Set<string>();
  if (entryIds.length > 0) {
    const live = await rows<{ entry_id: string }>(
      ctx,
      `SELECT entry_id FROM kith.investment_document_links
        WHERE space_id = $1 AND entry_id = ANY($2::text[])
          AND state = ANY($3::text[]) AND source_item_id <> $4`,
      [spaceId, entryIds, [...LIVE_STATES], sourceItemId],
    );
    for (const record of live) liveElsewhere.add(record.entry_id);
  }

  const byInvestment = new Map(
    investments.map((investment) => [investment.id, investment]),
  );
  const candidates: ScoredCandidate[] = [];
  for (const record of entryRecords) {
    const investment = byInvestment.get(record.investment_id);
    if (!investment) continue;
    if (settled.has(pairKey(record.investment_id, record.id))) continue;
    candidates.push(
      scoreCandidate({
        kind,
        statements: extraction.statements,
        investment,
        entry: toScorableEntry(record, liveElsewhere),
        pathNames,
      }),
    );
  }
  // Investment-level candidates, for the kinds that have no entry to point at.
  if (entryTypes.length === 0) {
    for (const investment of matched) {
      if (settled.has(pairKey(investment.id, null))) continue;
      candidates.push(
        scoreCandidate({
          kind,
          statements: extraction.statements,
          investment,
          entry: null,
          pathNames,
        }),
      );
    }
  }

  const decision = decideLinks({
    kind,
    candidates,
    maxSuggestions: MAX_LINK_SUGGESTIONS,
  });

  const written = new Map<string, { state: LinkState; candidate: ScoredCandidate }>();
  if (decision.autoLink) {
    written.set(pairKey(decision.autoLink.investmentId, decision.autoLink.entryId), {
      state: "auto_linked",
      candidate: decision.autoLink,
    });
  }
  for (const suggestion of decision.suggestions) {
    const key = pairKey(suggestion.investmentId, suggestion.entryId);
    if (written.has(key)) continue;
    written.set(key, { state: "suggested", candidate: suggestion });
  }

  const touchedEntries = new Set<string>();
  const datesReplaced: string[] = [];
  for (const [, entry] of written) {
    // `investment_document_links_evidence_check` refuses a rule-decided row
    // that cites nothing, and it is right to: a link nobody can check is the
    // silent wrong data this design exists to prevent. No score at or above
    // the threshold can be reached without a party or an amount statement, so
    // this skip is unreachable -- and it is here so that a future signal that
    // carries no citation fails to be written rather than failing the whole
    // transaction with a constraint violation.
    if (entry.candidate.evidence.length === 0) continue;
    const linkId = await upsertRuleLink(ctx, {
      spaceId,
      sourceItemId,
      documentId: document?.id ?? null,
      state: entry.state,
      candidate: entry.candidate,
    });
    if (entry.candidate.entryId !== null) touchedEntries.add(entry.candidate.entryId);
    if (entry.state === "auto_linked" && entry.candidate.entryId !== null) {
      const replaced = await replaceEstimatedDate(ctx, {
        spaceId,
        linkId,
        entryId: entry.candidate.entryId,
        replacement: entry.candidate.dateReplacement,
      });
      if (replaced) datesReplaced.push(entry.candidate.entryId);
    }
  }

  // Sweep the offers this pass no longer makes. `suggested` only: a live or
  // rejected row is a decision, not an offer.
  const keep = [...written.keys()];
  const stale = existing.filter(
    (link) =>
      link.state === "suggested" &&
      !keep.includes(pairKey(link.investment_id, link.entry_id)),
  );
  for (const link of stale) {
    await exec(
      ctx,
      `DELETE FROM kith.investment_document_links
        WHERE id = $1 AND space_id = $2 AND state = 'suggested'`,
      [link.id, spaceId],
    );
    if (link.entry_id !== null) touchedEntries.add(link.entry_id);
  }

  for (const entryId of touchedEntries) {
    await syncEntryDocument(ctx, spaceId, entryId);
  }

  return {
    evaluated: true,
    reason: "scored",
    kind: extraction.kind,
    autoLinkedEntryId: decision.autoLink?.entryId ?? null,
    suggestedCount: [...written.values()].filter(
      (entry) => entry.state === "suggested",
    ).length,
    datesReplaced,
  };
}

/**
 * Insert or refresh one rule-decided row.
 *
 * `ON CONFLICT` on the pair index, with a guard: a row the owner has settled
 * is never rewritten by a rule. Those pairs are excluded before scoring, so
 * the guard is belt to that braces -- and it is what makes this statement
 * safe if a future caller forgets.
 */
async function upsertRuleLink(
  ctx: IdentityCtx,
  args: {
    spaceId: string;
    sourceItemId: string;
    documentId: string | null;
    state: LinkState;
    candidate: ScoredCandidate;
  },
): Promise<string> {
  const id = newKithId();
  const record = await row<{ id: string }>(
    ctx,
    `INSERT INTO kith.investment_document_links
       (id, space_id, investment_id, entry_id, document_id, source_item_id,
        state, score, signals, evidence, decided_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'rule',$11)
     ON CONFLICT (space_id, source_item_id, investment_id,
                  coalesce(entry_id::text, ''))
     DO UPDATE SET
       state = EXCLUDED.state,
       document_id = EXCLUDED.document_id,
       score = EXCLUDED.score,
       signals = EXCLUDED.signals,
       evidence = EXCLUDED.evidence,
       decided_by = 'rule',
       decided_at = transaction_timestamp(),
       reason = EXCLUDED.reason
     WHERE kith.investment_document_links.state IN ('auto_linked', 'suggested')
     RETURNING id`,
    [
      id,
      args.spaceId,
      args.candidate.investmentId,
      args.candidate.entryId,
      args.documentId,
      args.sourceItemId,
      args.state,
      args.candidate.score,
      JSON.stringify(args.candidate.signals),
      JSON.stringify(args.candidate.evidence),
      args.candidate.reason,
    ],
  );
  if (record) return record.id;
  // The guard above refused the update, which means a settled row holds the
  // pair. Return its id rather than inventing one.
  const held = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.investment_document_links
      WHERE space_id = $1 AND source_item_id = $2 AND investment_id = $3
        AND coalesce(entry_id::text, '') = coalesce($4::text, '')`,
    [args.spaceId, args.sourceItemId, args.candidate.investmentId, args.candidate.entryId],
  );
  if (!held) linkNotFound();
  return held.id;
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

/**
 * Make `investment_entries.document_id` say what the links say.
 *
 * Called in the same transaction as every link write. The entry's citation is
 * the document of its one live link, and its `evidence_span_id` is the first
 * span that link cites -- looked up rather than trusted, so a span a cleanup
 * pass has since removed leaves a null instead of failing the write.
 */
export async function syncEntryDocument(
  ctx: IdentityCtx,
  spaceId: string,
  entryId: string,
): Promise<void> {
  await exec(
    ctx,
    `WITH live AS (
       SELECT document_id, evidence->0->>'evidenceSpanId' AS span
         FROM kith.investment_document_links
        WHERE space_id = $1 AND entry_id = $2
          AND state IN ('auto_linked', 'confirmed')
        LIMIT 1
     )
     UPDATE kith.investment_entries e
        SET document_id = (SELECT document_id FROM live),
            evidence_span_id = (
              SELECT s.id FROM kith.evidence_spans s, live
               WHERE s.id = live.span AND s.space_id = e.space_id)
      WHERE e.id = $2 AND e.space_id = $1`,
    [spaceId, entryId],
  );
}

// ---------------------------------------------------------------------------
// Slice 1b: the date replacement rule
// ---------------------------------------------------------------------------

/** The document date that may stand in for an estimated entry date, with the
 * citation that proves it. Produced by the scorer on an auto-link, and
 * re-derived by `deriveDateReplacement` when the owner confirms one. */
type DateReplacement = NonNullable<ScoredCandidate["dateReplacement"]>;

/**
 * The date replacement a stored link would make, worked out from the document
 * again rather than remembered.
 *
 * `confirmInvestmentDocumentLink` needs this because a `suggested` row was
 * written by a pass that had no business moving a date (the owner had not
 * agreed to the document yet), so the replacement it might imply was never
 * stored. Re-deriving is also the honest thing: the observation may have been
 * corrected since the suggestion was written, and the owner is confirming the
 * document as it reads NOW.
 *
 * Every guard the scorer applies applies again here: the kind must be one
 * this file knows, the entry's type must be one the kind can date, the field
 * must be one the kind may date FROM, and the value must be a day-precision
 * date inside the kind's window.
 */
async function deriveDateReplacement(
  ctx: IdentityCtx,
  link: LinkDbRow,
): Promise<DateReplacement | null> {
  if (link.entry_id === null) return null;
  const extraction = await readExtraction(ctx, link.space_id, link.source_item_id);
  if (!extraction) return null;
  const kind = matchableKind(extraction.kind);
  if (!kind || kind.dateReplacementFields.length === 0) return null;
  const entry = await row<{ entry_type: string; entry_date: Date | string }>(
    ctx,
    `SELECT entry_type, entry_date FROM kith.investment_entries
      WHERE id = $1 AND space_id = $2`,
    [link.entry_id, link.space_id],
  );
  if (!entry) return null;
  if (!kind.entryTypes.includes(entry.entry_type as InvestmentEntryType)) {
    return null;
  }
  const investment = await row<{ signed_on: Date | null }>(
    ctx,
    `SELECT signed_on FROM kith.investments WHERE id = $1 AND space_id = $2`,
    [link.investment_id, link.space_id],
  );
  for (const field of kind.dateReplacementFields) {
    const statement = extraction.statements.find((item) => item.field === field);
    if (!statement || !statement.value || statement.value.type !== "date") continue;
    const value = statement.value;
    if (
      !dateInWindow({
        documentDate: value.value,
        precision: value.precision,
        window: kind.dateWindow,
        entryDate: calendarDate(entry.entry_date),
        investmentSignedOn: calendarDate(investment?.signed_on ?? null),
      })
    ) {
      continue;
    }
    return {
      field,
      date: value.value,
      observationKey: statement.observationKey,
      evidenceSpanId: statement.evidenceSpanId,
    };
  }
  return null;
}

/**
 * Replace an ESTIMATED entry date with the date a linked document states.
 *
 * Every condition, and each one is the difference between a correction and a
 * fabrication:
 *
 *   * `date_is_estimated` is true. A date the owner typed or imported as
 *     exact is NEVER touched -- and the guard is in the UPDATE's own WHERE,
 *     not only in the branch above it, so a concurrent transaction that
 *     cleared the marker cannot be raced.
 *   * The link is live (`auto_linked` or `confirmed`).
 *   * The document's date statement passed the gate, which is what being a
 *     stored statement means, and it is a DAY. A `year` or `month` precision
 *     value never reaches here (`linkScoring.ts` refuses it as a window match
 *     in the first place), so no day is ever invented.
 *   * The field is one the kind may date this entry type from (section 3's
 *     table), which `ScoredCandidate.dateReplacement` already decided.
 *   * Exactly one document offers a date. The live-link index makes that
 *     structurally true -- an entry has at most one live link -- and the
 *     count below states the rule anyway, so it survives the day the index
 *     changes.
 *
 * Idempotent: the first run clears the marker, so a second run finds nothing
 * to do. A document that merely agrees with the estimate clears the marker
 * and writes NO correction row, because nothing changed and a digest entry
 * saying "2026-03-01 became 2026-03-01" is noise.
 *
 * Returns true when a date actually moved.
 */
async function replaceEstimatedDate(
  ctx: IdentityCtx,
  args: {
    spaceId: string;
    linkId: string;
    entryId: string;
    replacement: DateReplacement | null;
  },
): Promise<boolean> {
  const replacement = args.replacement;
  if (!replacement) return false;
  const current = await row<{ entry_date: Date | string; date_is_estimated: boolean }>(
    ctx,
    `SELECT entry_date, date_is_estimated FROM kith.investment_entries
      WHERE id = $1 AND space_id = $2 FOR UPDATE`,
    [args.entryId, args.spaceId],
  );
  if (!current || !current.date_is_estimated) return false;
  const live = await row<{ count: string }>(
    ctx,
    `SELECT count(*)::text AS count FROM kith.investment_document_links
      WHERE space_id = $1 AND entry_id = $2 AND state IN ('auto_linked', 'confirmed')`,
    [args.spaceId, args.entryId],
  );
  if (Number(live?.count ?? 0) !== 1) return false;

  const previous = calendarDate(current.entry_date)!;
  if (previous === replacement.date) {
    // The document confirms the estimate. Clear the marker, record nothing.
    await exec(
      ctx,
      `UPDATE kith.investment_entries SET date_is_estimated = false
        WHERE id = $1 AND space_id = $2 AND date_is_estimated`,
      [args.entryId, args.spaceId],
    );
    return false;
  }

  const correctionId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.corrections
       (id, space_id, target_kind, target_id, field_name, original_value,
        corrected_value, reason, state, resolved_at, detector, dedupe_key,
        severity)
     VALUES ($1,$2,'entry',$3,'entry_date',to_jsonb($4::text),to_jsonb($5::text),
             $6,'resolved',transaction_timestamp(),$7,$8,'info')`,
    [
      correctionId,
      args.spaceId,
      args.entryId,
      previous,
      replacement.date,
      // The cited observation and its span, so the change can be traced back
      // to the line of the page it came from.
      `${LINK_DATE_DETECTOR}:${args.linkId}:${replacement.field}:${replacement.observationKey}:${replacement.evidenceSpanId}`,
      LINK_DATE_DETECTOR,
      `${LINK_DATE_DETECTOR}:${args.entryId}:${args.linkId}`,
    ],
  );
  const moved = await row<{ id: string }>(
    ctx,
    `UPDATE kith.investment_entries
        SET entry_date = $3, date_is_estimated = false
      WHERE id = $1 AND space_id = $2 AND date_is_estimated
      RETURNING id`,
    [args.entryId, args.spaceId, replacement.date],
  );
  if (!moved) {
    // The marker went away under us. Undo the record rather than leave a
    // correction claiming a change that did not happen.
    await exec(
      ctx,
      `DELETE FROM kith.corrections WHERE id = $1 AND space_id = $2`,
      [correctionId, args.spaceId],
    );
    return false;
  }
  await exec(
    ctx,
    `UPDATE kith.investment_document_links SET date_correction_id = $3
      WHERE id = $1 AND space_id = $2`,
    [args.linkId, args.spaceId, correctionId],
  );
  return true;
}

/**
 * Undo a date this link replaced, because the link is being rejected.
 *
 * Rejecting a link is how the owner says the document was the wrong one, and
 * a date taken from the wrong document has to go back. The entry returns to
 * exactly the state it was in: the original date, marked estimated again, so
 * a later correct document may still move it.
 *
 * The one exception, and it is the owner's: if the entry's date is no longer
 * the one this link wrote, he has edited it since, and his value stands. The
 * link is still rejected and the marker is left exactly as he left it.
 *
 * The reversal is recorded as its own resolved correction, so the digest
 * shows the date going back as clearly as it showed it moving.
 */
async function revertReplacedDate(
  ctx: IdentityCtx,
  args: { spaceId: string; link: LinkDbRow },
): Promise<boolean> {
  const correctionId = args.link.date_correction_id;
  if (correctionId === null || args.link.entry_id === null) return false;
  const correction = await row<{
    original_value: unknown;
    corrected_value: unknown;
  }>(
    ctx,
    `SELECT original_value, corrected_value FROM kith.corrections
      WHERE id = $1 AND space_id = $2 AND target_kind = 'entry'`,
    [correctionId, args.spaceId],
  );
  // Whatever happens below, this link no longer owns a date.
  await exec(
    ctx,
    `UPDATE kith.investment_document_links SET date_correction_id = NULL
      WHERE id = $1 AND space_id = $2`,
    [args.link.id, args.spaceId],
  );
  if (!correction) return false;
  const original = correction.original_value;
  const applied = correction.corrected_value;
  if (typeof original !== "string" || typeof applied !== "string") return false;
  const current = await row<{ entry_date: Date | string }>(
    ctx,
    `SELECT entry_date FROM kith.investment_entries
      WHERE id = $1 AND space_id = $2 FOR UPDATE`,
    [args.link.entry_id, args.spaceId],
  );
  if (!current) return false;
  if (calendarDate(current.entry_date) !== applied) return false;
  await exec(
    ctx,
    `INSERT INTO kith.corrections
       (id, space_id, target_kind, target_id, field_name, original_value,
        corrected_value, reason, state, resolved_at, detector, dedupe_key,
        severity)
     VALUES ($1,$2,'entry',$3,'entry_date',to_jsonb($4::text),to_jsonb($5::text),
             $6,'resolved',transaction_timestamp(),$7,$8,'info')`,
    [
      newKithId(),
      args.spaceId,
      args.link.entry_id,
      applied,
      original,
      `${LINK_DATE_DETECTOR}_reverted:${args.link.id}`,
      LINK_DATE_DETECTOR,
      `${LINK_DATE_DETECTOR}_reverted:${args.link.entry_id}:${args.link.id}`,
    ],
  );
  await exec(
    ctx,
    `UPDATE kith.investment_entries
        SET entry_date = $3, date_is_estimated = true
      WHERE id = $1 AND space_id = $2`,
    [args.link.entry_id, args.spaceId, original],
  );
  return true;
}

// ---------------------------------------------------------------------------
// The owner's decisions
// ---------------------------------------------------------------------------

/** The link the caller may write, resolved from the row rather than trusted
 * from the request -- the two-step every write in `investments.ts` uses. */
async function writableLink(
  ctx: IdentityCtx,
  principal: Principal,
  linkId: string,
): Promise<LinkDbRow> {
  const id = assertKithId(linkId, "invalid_link_id");
  const record = await row<LinkDbRow>(
    ctx,
    `SELECT ${LINK_COLUMNS} FROM kith.investment_document_links WHERE id = $1`,
    [id],
  );
  if (!record) linkNotFound();
  try {
    await requireSpaceAccess(ctx, principal, record.space_id, "write");
  } catch (error) {
    // A link in a space the caller cannot write and a link that does not
    // exist are the same answer, so neither enumerates the other. Only the
    // space denial is translated: a bare `catch {}` would report a lost
    // connection or a serialization failure as "not found" too, which is
    // both a wrong answer and an invisible outage (`denyAsNotFound` in
    // `investments.ts` says the same thing at more length).
    if (error instanceof IdentityError && error.message === "Space not found") {
      linkNotFound();
    }
    throw error;
  }
  return record;
}

/**
 * The owner agrees with a link: it becomes `confirmed` and the entry carries
 * the document.
 *
 * A confirmation may move a date, for the same reason an auto-link may: a
 * `suggested` document the owner accepts is now the entry's evidence, and if
 * the entry's date was an estimate the document's date is better. The rule is
 * the same one, with the same guards.
 */
export async function confirmInvestmentDocumentLink(
  ctx: IdentityCtx,
  args: { principal: Principal; linkId: string },
): Promise<{ dateReplaced: boolean }> {
  const link = await writableLink(ctx, args.principal, args.linkId);
  if (link.state === "confirmed") return { dateReplaced: false };
  if (link.entry_id !== null) {
    // The live-link index would refuse this with a unique violation; refusing
    // it here says which rule was broken.
    const live = await row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.investment_document_links
        WHERE space_id = $1 AND entry_id = $2 AND id <> $3
          AND state IN ('auto_linked', 'confirmed')`,
      [link.space_id, link.entry_id, link.id],
    );
    if (live) {
      typedError(
        "entry_already_linked",
        "This entry already cites a document; reject that link first",
      );
    }
  }
  await exec(
    ctx,
    `UPDATE kith.investment_document_links
        SET state = 'confirmed', decided_by = 'owner',
            decided_at = transaction_timestamp(), actor_user_id = $3,
            model = NULL, reason = 'owner_confirmed'
      WHERE id = $1 AND space_id = $2`,
    [link.id, link.space_id, args.principal.userId],
  );
  if (link.entry_id === null) return { dateReplaced: false };
  await syncEntryDocument(ctx, link.space_id, link.entry_id);
  const dateReplaced = await replaceEstimatedDate(ctx, {
    spaceId: link.space_id,
    linkId: link.id,
    entryId: link.entry_id,
    replacement: await deriveDateReplacement(ctx, link),
  });
  return { dateReplaced };
}

/**
 * The owner says no. The row stays forever, in `rejected`, and the scorer
 * never proposes this pair again -- through a re-extraction, a re-parse or a
 * nightly sweep. That is the remembered rejection, and it is why this is a
 * table and not a nullable id.
 *
 * A date this link replaced goes back (see `revertReplacedDate`).
 */
export async function rejectInvestmentDocumentLink(
  ctx: IdentityCtx,
  args: { principal: Principal; linkId: string; reason?: string | null },
): Promise<{ dateReverted: boolean }> {
  const link = await writableLink(ctx, args.principal, args.linkId);
  if (link.state === "rejected") return { dateReverted: false };
  const dateReverted = await revertReplacedDate(ctx, {
    spaceId: link.space_id,
    link,
  });
  const reason =
    typeof args.reason === "string" && args.reason.trim()
      ? args.reason.trim().slice(0, 200)
      : "owner_rejected";
  await exec(
    ctx,
    `UPDATE kith.investment_document_links
        SET state = 'rejected', decided_by = 'owner',
            decided_at = transaction_timestamp(), actor_user_id = $3,
            model = NULL, reason = $4
      WHERE id = $1 AND space_id = $2`,
    [link.id, link.space_id, args.principal.userId, reason],
  );
  if (link.entry_id !== null) {
    await syncEntryDocument(ctx, link.space_id, link.entry_id);
  }
  return { dateReverted };
}

/**
 * The drawer's "this entry's document is that one", as a link.
 *
 * `investments.ts` calls this instead of writing `document_id` itself, so
 * there is exactly one code path that puts a document on an entry and the
 * mirror can never drift from the table.
 *
 * `documentId` null DETACHES: the entry's live link is rejected, with the
 * owner as the decider. Rejected rather than deleted, deliberately -- the
 * owner taking a document off an entry is the clearest statement there is
 * that the two do not go together, and a later sweep must not put it back.
 */
export async function setEntryDocument(
  ctx: IdentityCtx,
  args: {
    spaceId: string;
    investmentId: string;
    entryId: string;
    actorUserId: string;
    document: { id: string; sourceItemId: string } | null;
  },
): Promise<void> {
  const live = await row<LinkDbRow>(
    ctx,
    `SELECT ${LINK_COLUMNS} FROM kith.investment_document_links
      WHERE space_id = $1 AND entry_id = $2 AND state IN ('auto_linked', 'confirmed')
      LIMIT 1`,
    [args.spaceId, args.entryId],
  );
  if (live && args.document !== null && live.document_id === args.document.id) {
    return;
  }
  if (live) {
    await revertReplacedDate(ctx, { spaceId: args.spaceId, link: live });
    await exec(
      ctx,
      `UPDATE kith.investment_document_links
          SET state = 'rejected', decided_by = 'owner',
              decided_at = transaction_timestamp(), actor_user_id = $3,
              model = NULL, reason = 'owner_detached'
        WHERE id = $1 AND space_id = $2`,
      [live.id, args.spaceId, args.actorUserId],
    );
  }
  if (args.document !== null) {
    // An owner's own attachment carries no evidence: he did not read it off a
    // statement, he said so. `investment_document_links_evidence_check` allows
    // that for `decided_by = 'owner'` and for nothing else.
    await exec(
      ctx,
      `INSERT INTO kith.investment_document_links
         (id, space_id, investment_id, entry_id, document_id, source_item_id,
          state, score, signals, evidence, decided_by, actor_user_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed',0,'[]'::jsonb,'[]'::jsonb,'owner',
               $7,'owner_attached')
       ON CONFLICT (space_id, source_item_id, investment_id,
                    coalesce(entry_id::text, ''))
       DO UPDATE SET
         state = 'confirmed', document_id = EXCLUDED.document_id,
         decided_by = 'owner', decided_at = transaction_timestamp(),
         actor_user_id = EXCLUDED.actor_user_id, model = NULL,
         reason = 'owner_attached'`,
      [
        newKithId(),
        args.spaceId,
        args.investmentId,
        args.entryId,
        args.document.id,
        args.document.sourceItemId,
        args.actorUserId,
      ],
    );
  }
  await syncEntryDocument(ctx, args.spaceId, args.entryId);
}
