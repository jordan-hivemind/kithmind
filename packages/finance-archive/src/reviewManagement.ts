import { createHash } from "node:crypto";
import { withSchemaTransaction } from "@repo/pg";

import {
  insertAccountAliases,
  type AccountAliasKind,
} from "./accountAliases.js";
import type { ArchiveClient } from "./pgStore.js";
import {
  archiveSchemaOf,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "./pgStore.js";

export const FINANCE_REVIEW_STATUSES = [
  "open",
  "resolved",
  "dismissed",
] as const;
export type FinanceReviewStatus = (typeof FINANCE_REVIEW_STATUSES)[number];

export type FinanceReviewGuidance = {
  readonly category: "repair" | "acknowledge" | "external_action";
  readonly summary: string;
  readonly nextAction: string;
  readonly actionKinds: readonly FinanceReviewAction["kind"][];
};

export type FinanceReviewItem = {
  readonly id: string;
  readonly kind: string;
  readonly accountId: string | null;
  readonly institutionId: string | null;
  readonly sourceDocumentId: string | null;
  readonly sourceLocator: string | null;
  readonly rawValue: string | null;
  readonly reason: string;
  readonly reasonCode: string | null;
  readonly status: FinanceReviewStatus;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly matchedInstrumentId: string | null;
  readonly occurrenceCount: number | null;
  readonly lastSeenDocumentId: string | null;
  readonly guidance: FinanceReviewGuidance;
};

export type ListFinanceReviewItemsInput = {
  readonly accountId?: string;
  readonly kind?: string | readonly string[];
  readonly status?: FinanceReviewStatus | readonly FinanceReviewStatus[];
  readonly limit?: number;
  readonly cursor?: string;
};

export type ListFinanceReviewItemsResult = {
  readonly items: readonly FinanceReviewItem[];
  readonly nextCursor: string | null;
};

export type FinanceReviewDocument = {
  readonly id: string;
  readonly institutionId: string | null;
  readonly accountId: string | null;
  readonly docType: string;
  readonly docDate: string | null;
  readonly parsedOk: boolean;
  readonly notes: string | null;
  readonly retainedSha256: string | null;
  readonly retainedByteLength: string | null;
  readonly mediaType: string | null;
  readonly captureId: string | null;
};

export type FinanceReviewCanonicalRow = {
  readonly recordType: "transaction" | "position" | "balance" | "liability";
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string | null;
  readonly sourceDocumentId: string | null;
  readonly sourceLocator: string | null;
  readonly values: Readonly<Record<string, unknown>>;
};

export type FinanceReviewEvidence = {
  readonly format: string;
  readonly field: string | null;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly retainedText:
    | {
        readonly available: true;
        readonly verified: boolean;
        readonly quote: string;
        readonly truncated: boolean;
      }
    | { readonly available: false };
};

export type FinanceReviewInstrumentCandidate = {
  readonly id: string;
  readonly symbol: string | null;
  readonly cusip: string | null;
  readonly isin: string | null;
  readonly name: string | null;
  readonly instrumentKind: string | null;
  readonly assetClass: string | null;
  readonly identifierSourceInstitutionIds: readonly string[];
  readonly transactionReferences: number;
  readonly positionReferences: number;
};

export type FinanceReviewAccountCandidate = {
  readonly id: string;
  readonly institutionId: string;
  readonly externalKey: string | null;
  readonly displayName: string | null;
  readonly accountType: string | null;
  readonly last4: string | null;
  readonly aliases: readonly {
    readonly externalKey: string;
    readonly kind: AccountAliasKind;
    readonly learnedNote: string | null;
  }[];
};

export type FinanceReviewItemDetail = {
  readonly item: FinanceReviewItem;
  readonly account: {
    readonly id: string;
    readonly institutionId: string;
    readonly displayName: string | null;
    readonly accountType: string | null;
    readonly last4: string | null;
  } | null;
  readonly institution: { readonly id: string; readonly name: string } | null;
  readonly sourceDocument: FinanceReviewDocument | null;
  readonly lastSeenDocument: FinanceReviewDocument | null;
  readonly parsedSourceLocator: unknown | null;
  readonly evidence: readonly FinanceReviewEvidence[];
  readonly canonicalRows: readonly FinanceReviewCanonicalRow[];
  readonly canonicalRowsTruncated: boolean;
  readonly instrumentCandidates: readonly FinanceReviewInstrumentCandidate[];
  readonly accountCandidates: readonly FinanceReviewAccountCandidate[];
};

export type FinanceReviewAction =
  | {
      readonly kind: "confirm_instrument_match";
      readonly reviewItemId: string;
      readonly matchedInstrumentId: string;
      readonly note?: string;
    }
  | {
      readonly kind: "map_account_key";
      readonly reviewItemId: string;
      readonly targetAccountId: string;
      readonly aliasKind: AccountAliasKind;
      readonly note?: string;
    }
  | {
      readonly kind: "acknowledge_safeguard";
      readonly reviewItemId: string;
      readonly note?: string;
    }
  | {
      readonly kind: "dismiss";
      readonly reviewItemId: string;
      readonly note: string;
    };

export type FinanceReviewActionOutcome = {
  readonly reviewItemId: string;
  readonly action: FinanceReviewAction["kind"];
  readonly status: FinanceReviewStatus;
  readonly canonicalRowsChanged: number;
  readonly existingRowsRepaired: number;
  readonly reviewItemsChanged: number;
  readonly accountAliasesCreated: number;
  readonly mappingSaved: boolean;
  readonly description: string;
  readonly remainingAction: string | null;
};

export class FinanceReviewActionError extends Error {
  readonly code:
    | "invalid_action"
    | "invalid_cursor"
    | "not_found"
    | "not_open"
    | "conflict"
    | "safeguard_not_verified";

  constructor(code: FinanceReviewActionError["code"], message: string) {
    super(message);
    this.name = "FinanceReviewActionError";
    this.code = code;
  }
}

const SAFEGUARD_KINDS = new Set([
  "cash_on_noncash_activity",
  "quantity_on_nonquantity_activity",
  "ambiguous_market_value",
  "ambiguous_total_value",
  "duplicate_holding_removed",
]);

function guidanceFor(kind: string): FinanceReviewGuidance {
  if (kind === "weak_instrument_match") {
    return {
      category: "repair",
      summary:
        "A source descriptor was linked to an existing instrument using weak evidence.",
      nextAction:
        "Compare the retained evidence and identifier candidates, then confirm the stored instrument only when they describe the same security.",
      actionKinds: ["confirm_instrument_match", "dismiss"],
    };
  }
  if (kind === "unknown_account_key") {
    return {
      category: "repair",
      summary:
        "A source account key was not mapped, so the importer used its fallback account.",
      nextAction:
        "Choose an account in the same institution to save the key as an alias. Existing rows remain where they are until the offline re-attribution workflow runs.",
      actionKinds: ["map_account_key", "dismiss"],
    };
  }
  if (SAFEGUARD_KINDS.has(kind)) {
    return {
      category: "acknowledge",
      summary:
        kind === "duplicate_holding_removed"
          ? "A duplicate holding was already removed and this item is its durable audit record."
          : "The importer already withheld the questionable field instead of guessing a value.",
      nextAction:
        "Inspect the retained evidence and current canonical row, then acknowledge the applied safeguard or dismiss the review item.",
      actionKinds: ["acknowledge_safeguard", "dismiss"],
    };
  }

  const actions: Record<string, string> = {
    document_unparsed:
      "Repair or update the parser and reimport this retained document through the offline importer.",
    balance_cash_conflict:
      "Compare both retained statements and correct the source or parser offline; both conflicting canonical balances are intentionally retained.",
    undeclared_activity_type:
      "Add the activity type to the institution adapter taxonomy and reimport the affected document.",
    retention_dropped_fields:
      "Review the adapter retention declaration and extend it only if the dropped paths contain business data that should be retained.",
  };
  return {
    category: "external_action",
    summary:
      "This item needs source, parser, or adapter work outside the review service.",
    nextAction:
      actions[kind] ??
      "Inspect the retained evidence and repair the source or importer offline before resolving this item.",
    actionKinds: ["dismiss"],
  };
}

type ReviewRow = {
  id: string;
  kind: string;
  account_id: string | null;
  institution_id: string | null;
  effective_institution_id: string | null;
  source_document_id: string | null;
  source_locator: string | null;
  raw_value: string | null;
  reason: string;
  reason_code: string | null;
  status: FinanceReviewStatus;
  resolved_at: Date | string | null;
  resolution_note: string | null;
  matched_instrument_id: string | null;
  occurrence_count: number | null;
  last_seen_document_id: string | null;
};

function isoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function itemOf(row: ReviewRow): FinanceReviewItem {
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.account_id,
    institutionId: row.effective_institution_id ?? row.institution_id,
    sourceDocumentId: row.source_document_id,
    sourceLocator: row.source_locator,
    rawValue: row.raw_value,
    reason: row.reason,
    reasonCode: row.reason_code,
    status: row.status,
    resolvedAt: isoTimestamp(row.resolved_at),
    resolutionNote: row.resolution_note,
    matchedInstrumentId: row.matched_instrument_id,
    occurrenceCount: row.occurrence_count,
    lastSeenDocumentId: row.last_seen_document_id,
    guidance: guidanceFor(row.kind),
  };
}

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { v?: unknown }).v !== 1 ||
      typeof (parsed as { id?: unknown }).id !== "string" ||
      (parsed as { id: string }).id.length === 0
    )
      throw new Error("bad cursor");
    return (parsed as { id: string }).id;
  } catch {
    throw new FinanceReviewActionError(
      "invalid_cursor",
      "finance review cursor is invalid",
    );
  }
}

function many(
  value: string | readonly string[] | undefined,
): readonly string[] {
  return value === undefined ? [] : typeof value === "string" ? [value] : value;
}

async function listFinanceReviewItemsInSnapshot(
  client: ArchiveClient,
  input: ListFinanceReviewItemsInput = {},
): Promise<ListFinanceReviewItemsResult> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError(
      "finance review limit must be an integer from 1 through 100",
    );
  const kinds = many(input.kind);
  const statuses = many(input.status);
  if (
    statuses.some(
      (one) => !FINANCE_REVIEW_STATUSES.includes(one as FinanceReviewStatus),
    )
  )
    throw new RangeError("finance review status is invalid");

  const values: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (input.accountId !== undefined)
    where.push(`r.account_id = ${bind(input.accountId)}`);
  if (kinds.length > 0) where.push(`r.kind = ANY(${bind([...kinds])}::text[])`);
  if (statuses.length > 0)
    where.push(`r.status = ANY(${bind([...statuses])}::text[])`);
  const cursor = decodeCursor(input.cursor);
  if (cursor !== null) where.push(`r.id > ${bind(cursor)}`);
  values.push(limit + 1);

  const found = await client.query<ReviewRow>(
    `SELECT r.*,
            coalesce(r.institution_id, a.institution_id, d.institution_id)
              AS effective_institution_id
       FROM review_items r
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN documents d ON d.id = r.source_document_id
      ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
      ORDER BY r.id
      LIMIT $${values.length}`,
    values,
  );
  const hasMore = found.rows.length > limit;
  const rows = hasMore ? found.rows.slice(0, limit) : found.rows;
  return {
    items: rows.map(itemOf),
    nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id) : null,
  };
}

/**
 * Lists review items inside one pinned, read-only snapshot. The caller owns
 * the connection, while this service owns the transaction boundary.
 */
export async function listFinanceReviewItems(
  client: ArchiveClient,
  input: ListFinanceReviewItemsInput = {},
): Promise<ListFinanceReviewItemsResult> {
  return withSchemaTransaction(
    client,
    archiveSchemaOf(client),
    (tx) => listFinanceReviewItemsInSnapshot(tx, input),
    { isolation: "REPEATABLE READ", readOnly: true },
  );
}

type DetailRow = ReviewRow & {
  account_institution_id: string | null;
  account_display_name: string | null;
  account_type: string | null;
  account_last4: string | null;
  institution_name: string | null;
  document_id: string | null;
  document_institution_id: string | null;
  document_account_id: string | null;
  document_type: string | null;
  document_date: string | null;
  document_parsed_ok: boolean | null;
  document_notes: string | null;
  document_retained_sha256: string | null;
  document_retained_byte_length: string | null;
  document_media_type: string | null;
  document_capture_id: string | null;
  last_document_id: string | null;
  last_document_institution_id: string | null;
  last_document_account_id: string | null;
  last_document_type: string | null;
  last_document_date: string | null;
  last_document_parsed_ok: boolean | null;
  last_document_notes: string | null;
  last_document_retained_sha256: string | null;
  last_document_retained_byte_length: string | null;
  last_document_media_type: string | null;
  last_document_capture_id: string | null;
};

function documentOf(
  row: DetailRow,
  last: boolean,
): FinanceReviewDocument | null {
  const prefix = last ? "last_document_" : "document_";
  const value = row as unknown as Record<string, unknown>;
  const id = value[`${prefix}id`];
  if (typeof id !== "string") return null;
  return {
    id,
    institutionId: (value[`${prefix}institution_id`] as string | null) ?? null,
    accountId: (value[`${prefix}account_id`] as string | null) ?? null,
    docType: value[`${prefix}type`] as string,
    docDate: (value[`${prefix}date`] as string | null) ?? null,
    parsedOk: value[`${prefix}parsed_ok`] as boolean,
    notes: (value[`${prefix}notes`] as string | null) ?? null,
    retainedSha256:
      (value[`${prefix}retained_sha256`] as string | null) ?? null,
    retainedByteLength:
      (value[`${prefix}retained_byte_length`] as string | null) ?? null,
    mediaType: (value[`${prefix}media_type`] as string | null) ?? null,
    captureId: (value[`${prefix}capture_id`] as string | null) ?? null,
  };
}

function parseLocator(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

type EvidenceBinding = {
  field: string | null;
  locator: Record<string, unknown>;
};

function evidenceBindings(
  value: unknown,
  field: string | null = null,
): EvidenceBinding[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.flatMap((one) => evidenceBindings(one, field));
  const object = value as Record<string, unknown>;
  const ownField = typeof object.field === "string" ? object.field : field;
  if (typeof object.format === "string")
    return [{ field: ownField, locator: object }];
  return Object.entries(object).flatMap(([key, one]) =>
    evidenceBindings(one, field ?? key),
  );
}

async function evidenceOf(
  client: ArchiveClient,
  locators: readonly (string | null)[],
): Promise<FinanceReviewEvidence[]> {
  const bindings = locators
    .flatMap((locator) => evidenceBindings(parseLocator(locator)))
    .slice(0, 20);
  const hashes = [
    ...new Set(
      bindings
        .map(({ locator }) => locator.textSha256)
        .filter(
          (one): one is string =>
            typeof one === "string" && /^[a-f0-9]{64}$/.test(one),
        ),
    ),
  ];
  const retained = new Map<string, Buffer>();
  if (hashes.length > 0) {
    const found = await client.query<{ sha256: string; content: Buffer }>(
      "SELECT sha256, content FROM retained_texts WHERE sha256 = ANY($1::text[])",
      [hashes],
    );
    for (const row of found.rows) retained.set(row.sha256, row.content);
  }

  return bindings.map(({ field, locator }) => {
    const format = locator.format as string;
    const sha = locator.textSha256;
    const start = locator.start;
    const end = locator.end;
    if (
      format !== "retained_text_span_v1" ||
      typeof sha !== "string" ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    ) {
      return { format, field, locator, retainedText: { available: false } };
    }
    const bytes = retained.get(sha);
    if (bytes === undefined)
      return { format, field, locator, retainedText: { available: false } };
    const text = bytes.toString("utf8");
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    const codepoints = Array.from(text);
    if (end > codepoints.length)
      return { format, field, locator, retainedText: { available: false } };
    const fullQuote = codepoints.slice(start, end).join("");
    const max = 2_000;
    return {
      format,
      field,
      locator,
      retainedText: {
        available: true,
        verified: actualHash === sha && fullQuote === locator.quote,
        quote: fullQuote.slice(0, max),
        truncated: fullQuote.length > max,
      },
    };
  });
}

type CanonicalRow = {
  record_type: FinanceReviewCanonicalRow["recordType"];
  id: string;
  account_id: string;
  instrument_id: string | null;
  source_document_id: string | null;
  source_locator: string | null;
  values: Record<string, unknown>;
};

async function canonicalRowsFor(
  client: ArchiveClient,
  documentId: string | null,
  sourceLocator: string | null,
  limit: number,
): Promise<{ rows: FinanceReviewCanonicalRow[]; truncated: boolean }> {
  if (documentId === null) return { rows: [], truncated: false };
  const found = await client.query<CanonicalRow>(
    `SELECT * FROM (
       SELECT 'transaction'::text AS record_type, id, account_id, instrument_id,
              source_document_id, source_locator,
              jsonb_build_object(
                'tradeDate', trade_date::text, 'processDate', process_date::text,
                'settleDate', settle_date::text, 'activityType', activity_type,
                'description', description, 'quantity', quantity::text,
                'price', price::text, 'amount', amount::text, 'currency', currency,
                'status', status) AS values
         FROM transactions
        WHERE source_document_id = $1 AND ($2::text IS NULL OR source_locator = $2)
       UNION ALL
       SELECT 'position', id, account_id, instrument_id, source_document_id, source_locator,
              jsonb_build_object(
                'asOf', as_of::text, 'quantity', quantity::text, 'price', price::text,
                'marketValue', market_value::text, 'costBasis', cost_basis::text,
                'unrealized', unrealized::text, 'currency', currency,
                'valuationBasis', valuation_basis, 'valuationNote', valuation_note)
         FROM positions
        WHERE source_document_id = $1 AND ($2::text IS NULL OR source_locator = $2)
       UNION ALL
       SELECT 'balance', id, account_id, NULL, source_document_id, source_locator,
              jsonb_build_object(
                'asOf', as_of::text, 'totalValue', total_value::text, 'cash', cash::text,
                'currency', currency, 'periodStartValue', period_start_value::text,
                'periodEndValue', period_end_value::text)
         FROM balances
        WHERE source_document_id = $1 AND ($2::text IS NULL OR source_locator = $2)
       UNION ALL
       SELECT 'liability', id, account_id, NULL, source_document_id, source_locator,
              jsonb_build_object(
                'asOf', as_of::text, 'kind', kind, 'displayName', display_name,
                'balance', balance::text, 'currency', currency, 'rate', rate::text,
                'collateralNote', collateral_note)
         FROM liabilities
        WHERE source_document_id = $1 AND ($2::text IS NULL OR source_locator = $2)
     ) related
     ORDER BY record_type, id
     LIMIT $3`,
    [documentId, sourceLocator, limit + 1],
  );
  const truncated = found.rows.length > limit;
  return {
    truncated,
    rows: found.rows.slice(0, limit).map((row) => ({
      recordType: row.record_type,
      id: row.id,
      accountId: row.account_id,
      instrumentId: row.instrument_id,
      sourceDocumentId: row.source_document_id,
      sourceLocator: row.source_locator,
      values: row.values,
    })),
  };
}

async function instrumentCandidatesFor(
  client: ArchiveClient,
  row: DetailRow,
): Promise<FinanceReviewInstrumentCandidate[]> {
  if (row.kind !== "weak_instrument_match") return [];
  const raw = parseLocator(row.raw_value);
  const symbol =
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { symbol?: unknown }).symbol === "string"
      ? (raw as { symbol: string }).symbol
      : null;
  const found = await client.query<{
    id: string;
    symbol: string | null;
    cusip: string | null;
    isin: string | null;
    name: string | null;
    instrument_kind: string | null;
    asset_class: string | null;
    source_ids: string[] | null;
    transaction_references: string;
    position_references: string;
  }>(
    `SELECT i.id, i.symbol, i.cusip, i.isin, i.name, i.instrument_kind, i.asset_class,
            array_agg(DISTINCT s.institution_id)
              FILTER (WHERE s.institution_id IS NOT NULL) AS source_ids,
            (SELECT count(*)::text FROM transactions t WHERE t.instrument_id = i.id)
              AS transaction_references,
            (SELECT count(*)::text FROM positions p WHERE p.instrument_id = i.id)
              AS position_references
       FROM instruments i
       LEFT JOIN instrument_identifier_sources s ON s.instrument_id = i.id
      WHERE i.id = $1
         OR ($2::text IS NOT NULL AND upper(btrim(i.symbol)) = upper(btrim($2)))
      GROUP BY i.id
      ORDER BY (i.id = $1) DESC, i.id
      LIMIT 25`,
    [row.matched_instrument_id, symbol],
  );
  return found.rows.map((candidate) => ({
    id: candidate.id,
    symbol: candidate.symbol,
    cusip: candidate.cusip,
    isin: candidate.isin,
    name: candidate.name,
    instrumentKind: candidate.instrument_kind,
    assetClass: candidate.asset_class,
    identifierSourceInstitutionIds: candidate.source_ids ?? [],
    transactionReferences: Number(candidate.transaction_references),
    positionReferences: Number(candidate.position_references),
  }));
}

async function accountCandidatesFor(
  client: ArchiveClient,
  row: DetailRow,
): Promise<FinanceReviewAccountCandidate[]> {
  if (
    row.kind !== "unknown_account_key" ||
    row.effective_institution_id === null
  )
    return [];
  const found = await client.query<{
    id: string;
    institution_id: string;
    external_key: string | null;
    display_name: string | null;
    account_type: string | null;
    acct_last4: string | null;
    aliases: Array<{
      externalKey: string;
      kind: AccountAliasKind;
      learnedNote: string | null;
    }> | null;
  }>(
    `SELECT a.id, a.institution_id, a.external_key, a.display_name, a.account_type,
            a.acct_last4,
            jsonb_agg(jsonb_build_object(
              'externalKey', aa.external_key, 'kind', aa.kind,
              'learnedNote', aa.learned_note) ORDER BY aa.external_key)
              FILTER (WHERE aa.id IS NOT NULL) AS aliases
       FROM accounts a
       LEFT JOIN account_aliases aa ON aa.account_id = a.id
      WHERE a.institution_id = $1
      GROUP BY a.id
      ORDER BY (a.id = $2) DESC, a.display_name NULLS LAST, a.id
      LIMIT 100`,
    [row.effective_institution_id, row.account_id],
  );
  return found.rows.map((account) => ({
    id: account.id,
    institutionId: account.institution_id,
    externalKey: account.external_key,
    displayName: account.display_name,
    accountType: account.account_type,
    last4: account.acct_last4,
    aliases: account.aliases ?? [],
  }));
}

async function getFinanceReviewItemInSnapshot(
  client: ArchiveClient,
  id: string,
  options: { readonly relatedLimit?: number } = {},
): Promise<FinanceReviewItemDetail | null> {
  const relatedLimit = options.relatedLimit ?? 100;
  if (
    !Number.isSafeInteger(relatedLimit) ||
    relatedLimit < 1 ||
    relatedLimit > 500
  )
    throw new RangeError(
      "finance review relatedLimit must be an integer from 1 through 500",
    );
  const found = await client.query<DetailRow>(
    `SELECT r.*,
            coalesce(r.institution_id, a.institution_id, d.institution_id)
              AS effective_institution_id,
            a.institution_id AS account_institution_id,
            a.display_name AS account_display_name, a.account_type,
            a.acct_last4 AS account_last4,
            i.name AS institution_name,
            d.id AS document_id, d.institution_id AS document_institution_id,
            d.account_id AS document_account_id, d.doc_type AS document_type,
            d.doc_date::text AS document_date, d.parsed_ok AS document_parsed_ok,
            d.notes AS document_notes, d.retained_sha256 AS document_retained_sha256,
            d.retained_byte_length::text AS document_retained_byte_length,
            d.media_type AS document_media_type, d.capture_id AS document_capture_id,
            ld.id AS last_document_id,
            ld.institution_id AS last_document_institution_id,
            ld.account_id AS last_document_account_id,
            ld.doc_type AS last_document_type, ld.doc_date::text AS last_document_date,
            ld.parsed_ok AS last_document_parsed_ok, ld.notes AS last_document_notes,
            ld.retained_sha256 AS last_document_retained_sha256,
            ld.retained_byte_length::text AS last_document_retained_byte_length,
            ld.media_type AS last_document_media_type,
            ld.capture_id AS last_document_capture_id
       FROM review_items r
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN documents d ON d.id = r.source_document_id
       LEFT JOIN documents ld ON ld.id = r.last_seen_document_id
       LEFT JOIN institutions i
         ON i.id = coalesce(r.institution_id, a.institution_id, d.institution_id)
      WHERE r.id = $1`,
    [id],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  const canonical = await canonicalRowsFor(
    client,
    row.source_document_id,
    row.source_locator,
    relatedLimit,
  );
  const [evidence, instrumentCandidates, accountCandidates] = await Promise.all(
    [
      evidenceOf(client, [
        row.source_locator,
        ...canonical.rows.map((one) => one.sourceLocator),
      ]),
      instrumentCandidatesFor(client, row),
      accountCandidatesFor(client, row),
    ],
  );
  return {
    item: itemOf(row),
    account:
      row.account_id === null || row.account_institution_id === null
        ? null
        : {
            id: row.account_id,
            institutionId: row.account_institution_id,
            displayName: row.account_display_name,
            accountType: row.account_type,
            last4: row.account_last4,
          },
    institution:
      row.effective_institution_id === null || row.institution_name === null
        ? null
        : { id: row.effective_institution_id, name: row.institution_name },
    sourceDocument: documentOf(row, false),
    lastSeenDocument: documentOf(row, true),
    parsedSourceLocator: parseLocator(row.source_locator),
    evidence,
    canonicalRows: canonical.rows,
    canonicalRowsTruncated: canonical.truncated,
    instrumentCandidates,
    accountCandidates,
  };
}

/** Reads one evidence-rich item inside a pinned, read-only snapshot. */
export async function getFinanceReviewItem(
  client: ArchiveClient,
  id: string,
  options: { readonly relatedLimit?: number } = {},
): Promise<FinanceReviewItemDetail | null> {
  return withSchemaTransaction(
    client,
    archiveSchemaOf(client),
    (tx) => getFinanceReviewItemInSnapshot(tx, id, options),
    { isolation: "REPEATABLE READ", readOnly: true },
  );
}

async function lockedItem(
  client: ArchiveClient,
  id: string,
): Promise<ReviewRow> {
  const found = await client.query<ReviewRow>(
    `SELECT r.*,
            coalesce(r.institution_id, a.institution_id, d.institution_id)
              AS effective_institution_id
       FROM review_items r
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN documents d ON d.id = r.source_document_id
      WHERE r.id = $1
      FOR UPDATE OF r`,
    [id],
  );
  const row = found.rows[0];
  if (row === undefined)
    throw new FinanceReviewActionError(
      "not_found",
      `finance review item ${id} was not found`,
    );
  if (row.status !== "open")
    throw new FinanceReviewActionError(
      "not_open",
      `finance review item ${id} is ${row.status}, not open`,
    );
  return row;
}

function actionNote(prefix: string, note: string | undefined): string {
  const trimmed = note?.trim();
  return trimmed ? `${prefix}: ${trimmed}` : prefix;
}

async function setReviewStatus(
  client: ArchiveClient,
  id: string,
  status: "resolved" | "dismissed",
  note: string,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE review_items
        SET status = $2, resolved_at = $3, resolution_note = $4
      WHERE id = $1`,
    [id, status, now.toISOString(), note],
  );
}

async function confirmInstrumentMatch(
  client: ArchiveClient,
  row: ReviewRow,
  action: Extract<FinanceReviewAction, { kind: "confirm_instrument_match" }>,
  now: Date,
): Promise<FinanceReviewActionOutcome> {
  if (
    row.kind !== "weak_instrument_match" ||
    row.matched_instrument_id === null ||
    row.institution_id === null
  )
    throw new FinanceReviewActionError(
      "invalid_action",
      "only a weak instrument review with a stored institution and candidate can be confirmed",
    );
  if (action.matchedInstrumentId !== row.matched_instrument_id)
    throw new FinanceReviewActionError(
      "conflict",
      "the confirmed instrument does not match this review item's stored candidate",
    );
  const instrument = await client.query<{ id: string }>(
    "SELECT id FROM instruments WHERE id = $1",
    [row.matched_instrument_id],
  );
  if (instrument.rows.length !== 1)
    throw new FinanceReviewActionError(
      "conflict",
      "the stored instrument candidate no longer exists",
    );

  const references = await client.query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM transactions
         WHERE instrument_id = $1
           AND ((source_document_id = $2 AND ($4::text IS NULL OR source_locator = $4))
             OR ($4::text IS NULL AND source_document_id = $3))) +
       (SELECT count(*) FROM positions
         WHERE instrument_id = $1
           AND ((source_document_id = $2 AND ($4::text IS NULL OR source_locator = $4))
             OR ($4::text IS NULL AND source_document_id = $3)))
     )::text AS n`,
    [
      row.matched_instrument_id,
      row.source_document_id,
      row.last_seen_document_id,
      row.source_locator,
    ],
  );
  const count = Number(references.rows[0]?.n ?? 0);
  if (count < 1)
    throw new FinanceReviewActionError(
      "conflict",
      "no current canonical row at this review item's source evidence uses the stored instrument candidate; the item remains open",
    );
  await setReviewStatus(
    client,
    row.id,
    "resolved",
    actionNote(
      `confirmed instrument ${row.matched_instrument_id}; ${count} current canonical source row(s) already use this instrument, so no rebind was needed`,
      action.note,
    ),
    now,
  );
  return {
    reviewItemId: row.id,
    action: action.kind,
    status: "resolved",
    canonicalRowsChanged: 0,
    existingRowsRepaired: 0,
    reviewItemsChanged: 1,
    accountAliasesCreated: 0,
    mappingSaved: false,
    description:
      `Confirmed the existing canonical link to instrument ${row.matched_instrument_id}. ` +
      `${count} related canonical source row(s) already used it; this action changed no monetary or holding data.`,
    remainingAction: null,
  };
}

async function mapAccountKey(
  client: ArchiveClient,
  row: ReviewRow,
  action: Extract<FinanceReviewAction, { kind: "map_account_key" }>,
  now: Date,
): Promise<FinanceReviewActionOutcome> {
  if (
    row.kind !== "unknown_account_key" ||
    row.raw_value === null ||
    row.effective_institution_id === null
  )
    throw new FinanceReviewActionError(
      "invalid_action",
      "only an unknown account key with a known institution can be mapped",
    );
  const institutionId = row.effective_institution_id;
  const target = await client.query<{ id: string }>(
    "SELECT id FROM accounts WHERE id = $1 AND institution_id = $2",
    [action.targetAccountId, institutionId],
  );
  if (target.rows.length !== 1)
    throw new FinanceReviewActionError(
      "conflict",
      "the target account does not belong to this review item's institution",
    );
  const conflict = await client.query<{ account_id: string }>(
    `SELECT account_id FROM (
       SELECT id AS account_id FROM accounts
        WHERE institution_id = $1 AND external_key = $2
       UNION
       SELECT account_id FROM account_aliases
        WHERE institution_id = $1 AND external_key = $2
     ) known`,
    [institutionId, row.raw_value],
  );
  if (conflict.rows.some((one) => one.account_id !== action.targetAccountId))
    throw new FinanceReviewActionError(
      "conflict",
      "this key already maps to a different account in the same institution",
    );

  const learnedNote = actionNote(
    `mapped from finance review item ${row.id}`,
    action.note,
  );
  const accountAliasesCreated =
    conflict.rows.length === 0
      ? await insertAccountAliases(
          client,
          institutionId,
          new Map([[row.raw_value, action.targetAccountId]]),
          action.aliasKind,
          learnedNote,
        )
      : 0;
  let relatedRows = 0;
  let wrongAccountRows = 0;
  if (row.source_document_id !== null && row.source_locator !== null) {
    const checked = await client.query<{ rows: string; wrong: string }>(
      `SELECT count(*)::text AS rows,
              count(*) FILTER (WHERE account_id <> $3)::text AS wrong
         FROM (
           SELECT account_id FROM transactions
            WHERE source_document_id = $1 AND source_locator = $2
           UNION ALL
           SELECT account_id FROM positions
            WHERE source_document_id = $1 AND source_locator = $2
           UNION ALL
           SELECT account_id FROM balances
            WHERE source_document_id = $1 AND source_locator = $2
           UNION ALL
           SELECT account_id FROM liabilities
            WHERE source_document_id = $1 AND source_locator = $2
         ) related`,
      [row.source_document_id, row.source_locator, action.targetAccountId],
    );
    relatedRows = Number(checked.rows[0]?.rows ?? 0);
    wrongAccountRows = Number(checked.rows[0]?.wrong ?? 0);
  }
  const alreadyCorrect = relatedRows > 0 && wrongAccountRows === 0;
  if (alreadyCorrect) {
    await setReviewStatus(
      client,
      row.id,
      "resolved",
      `${learnedNote}; the alias now preserves this mapping and all ${relatedRows} source-pointed canonical row(s) were already attributed to account ${action.targetAccountId}`,
      now,
    );
  }
  return {
    reviewItemId: row.id,
    action: action.kind,
    status: alreadyCorrect ? "resolved" : "open",
    canonicalRowsChanged: 0,
    existingRowsRepaired: 0,
    reviewItemsChanged: alreadyCorrect ? 1 : 0,
    accountAliasesCreated,
    mappingSaved: true,
    description:
      accountAliasesCreated === 1
        ? `Saved the account key as an alias for ${action.targetAccountId}. No existing canonical rows were moved.`
        : `The account key already resolves to ${action.targetAccountId}. No existing canonical rows were moved.`,
    remainingAction: alreadyCorrect
      ? null
      : "Run the offline reattribute-accounts workflow to repair historical canonical rows filed under a fallback account; this review item remains open until attribution is verified.",
  };
}

async function acknowledgeSafeguard(
  client: ArchiveClient,
  row: ReviewRow,
  action: Extract<FinanceReviewAction, { kind: "acknowledge_safeguard" }>,
  now: Date,
): Promise<FinanceReviewActionOutcome> {
  if (!SAFEGUARD_KINDS.has(row.kind))
    throw new FinanceReviewActionError(
      "invalid_action",
      `${row.kind} is not a safeguard this service can verify and acknowledge`,
    );
  let verified: string;
  if (row.kind === "duplicate_holding_removed") {
    verified =
      "the duplicate-removal audit record already describes the completed deletion";
  } else {
    const table =
      row.kind === "ambiguous_market_value"
        ? "positions"
        : row.kind === "ambiguous_total_value"
          ? "balances"
          : "transactions";
    const column =
      row.kind === "cash_on_noncash_activity"
        ? "amount"
        : row.kind === "quantity_on_nonquantity_activity"
          ? "quantity"
          : row.kind === "ambiguous_market_value"
            ? "market_value"
            : "total_value";
    if (row.source_document_id === null)
      throw new FinanceReviewActionError(
        "safeguard_not_verified",
        "this review item has no source document to verify against a canonical row",
      );
    const checked = await client.query<{ rows: string; nonnull: string }>(
      `SELECT count(*)::text AS rows,
              count(*) FILTER (WHERE ${column} IS NOT NULL)::text AS nonnull
         FROM ${table}
        WHERE source_document_id = $1
          AND ($2::text IS NULL OR source_locator = $2)`,
      [row.source_document_id, row.source_locator],
    );
    const rows = Number(checked.rows[0]?.rows ?? 0);
    const nonnull = Number(checked.rows[0]?.nonnull ?? 0);
    if (rows < 1 || nonnull > 0)
      throw new FinanceReviewActionError(
        "safeguard_not_verified",
        `expected at least one related ${table} row with ${column} NULL; found ${rows} row(s), ${nonnull} with a value`,
      );
    verified = `${rows} related ${table} row(s) keep ${column} NULL, so no questionable value entered canonical data`;
  }
  await setReviewStatus(
    client,
    row.id,
    "resolved",
    actionNote(`acknowledged applied safeguard: ${verified}`, action.note),
    now,
  );
  return {
    reviewItemId: row.id,
    action: action.kind,
    status: "resolved",
    canonicalRowsChanged: 0,
    existingRowsRepaired: 0,
    reviewItemsChanged: 1,
    accountAliasesCreated: 0,
    mappingSaved: false,
    description: `Acknowledged that ${verified}. No canonical data was changed by this action.`,
    remainingAction: null,
  };
}

async function dismissReview(
  client: ArchiveClient,
  row: ReviewRow,
  action: Extract<FinanceReviewAction, { kind: "dismiss" }>,
  now: Date,
): Promise<FinanceReviewActionOutcome> {
  const note = action.note.trim();
  if (note.length === 0)
    throw new FinanceReviewActionError(
      "invalid_action",
      "dismissal requires a non-empty note",
    );
  await setReviewStatus(client, row.id, "dismissed", `dismissed: ${note}`, now);
  return {
    reviewItemId: row.id,
    action: action.kind,
    status: "dismissed",
    canonicalRowsChanged: 0,
    existingRowsRepaired: 0,
    reviewItemsChanged: 1,
    accountAliasesCreated: 0,
    mappingSaved: false,
    description:
      "Dismissed the review item by explicit owner decision. No canonical data was changed.",
    remainingAction: null,
  };
}

export async function actOnFinanceReviewItem(
  client: ArchiveClient,
  action: FinanceReviewAction,
  now = new Date(),
): Promise<FinanceReviewActionOutcome> {
  if (Number.isNaN(now.getTime()))
    throw new RangeError("finance review action time is invalid");
  return withArchiveTransaction(client, async (tx) => {
    await lockArchiveForWrite(tx);
    const row = await lockedItem(tx, action.reviewItemId);
    switch (action.kind) {
      case "confirm_instrument_match":
        return confirmInstrumentMatch(tx, row, action, now);
      case "map_account_key":
        return mapAccountKey(tx, row, action, now);
      case "acknowledge_safeguard":
        return acknowledgeSafeguard(tx, row, action, now);
      case "dismiss":
        return dismissReview(tx, row, action, now);
    }
  });
}
