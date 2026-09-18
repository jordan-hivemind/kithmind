import { createHash } from "node:crypto";

export const FINANCE_READ_CONTRACT_VERSION = 1 as const;
export const MAX_FINANCE_DECIMAL_DIGITS = 38;
export const MAX_FINANCE_DECIMAL_SCALE = 18;
export const MAX_FINANCE_PAGE_SIZE = 100;
export const MAX_FINANCE_EVIDENCE_REFS = 16;
export const MAX_FINANCE_AGGREGATE_CONTRIBUTORS = 25;
export const MAX_FINANCE_EVIDENCE_QUOTE_BYTES = 4096;
export const MAX_FINANCE_REQUEST_BYTES = 16 * 1024;
export const MAX_FINANCE_RESPONSE_BYTES = 512 * 1024;
export const MAX_FINANCE_SNAPSHOT_SUMMARY_POSITIONS = 10_000;
export const MAX_FINANCE_SNAPSHOT_SUMMARY_EVIDENCE_BYTES = 8 * 1024 * 1024;

export const FINANCE_READ_REQUEST_DESCRIPTION =
  "A closed finance read request. Every request requires contractVersion: 1, " +
  "spaceId, operation, and limit from 1 through 100. Resolve an account before " +
  "requesting holdings. Example: " +
  '{"contractVersion":1,"spaceId":"space-synthetic-001","operation":"list_accounts","limit":10,"institutionName":"Example Broker","accountLast4":"1234","displayLabel":"Income"}. ' +
  "Never guess an accountId. If matchStatus is ambiguous, show the candidates " +
  "and require disambiguation. For one exact snapshot use: " +
  '{"contractVersion":1,"spaceId":"space-synthetic-001","operation":"get_holdings_snapshot","limit":100,"accountId":"account-synthetic-001","snapshot":{"mode":"exact","asOf":"2026-07-31"}}. ' +
  "For the latest eligible snapshot, use snapshot mode latest with optional " +
  "onOrBefore. Exact mode never substitutes another date. To continue a page, " +
  "send the same operation, filters, selector, and limit, add nextCursor as " +
  "cursor, and add the response datasetRevision as expectedDatasetRevision. " +
  "If the cursor is invalid or the revision changed, restart from page one.";

export const FINANCE_READ_TOOL_DESCRIPTION =
  "Read authorized finance data through bounded typed operations: " +
  "list_accounts, get_holdings_snapshot, list_transactions, list_holdings, " +
  "list_balances, aggregate_money, get_evidence, and get_coverage. " +
  "The legacy list_holdings asOf field is an upper bound over historical rows; " +
  "use get_holdings_snapshot for exact-date or latest-snapshot selection.";

export const FINANCE_CURRENCY_REGISTRY_VERSION =
  "iso-4217-six-list-one-2026-01-p1" as const;
export const SUPPORTED_FINANCE_CURRENCIES = [
  "AUD",
  "CAD",
  "CHF",
  "CNY",
  "EUR",
  "GBP",
  "HKD",
  "INR",
  "JPY",
  "KRW",
  "MXN",
  "NZD",
  "SEK",
  "SGD",
  "USD",
] as const;

const encoder = new TextEncoder();
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURSOR = /^[A-Za-z0-9._-]{16,2048}$/;
const RELATIVE_SEGMENT = /^[^/\\\u0000-\u001f\u007f]{1,128}$/u;
const MEDIA_TYPE =
  /^(?:application\/pdf|application\/json|text\/csv; charset=utf-8|text\/plain; charset=utf-8)$/;
const JSON_POINTER_SEGMENT = /^(?:[^~\u0000-\u001f\u007f]|~[01])*$/u;
const CANONICAL_DECIMAL =
  /^(?:0|-?(?:[1-9]\d*|0\.\d*[1-9]|[1-9]\d*\.\d*[1-9]))$/;
const DECIMAL_INPUT = /^(-?)(\d+)(?:\.(\d+))?$/;
const supportedCurrencies = new Set<string>(SUPPORTED_FINANCE_CURRENCIES);

export type FinanceContractErrorCode =
  | "invalid_request"
  | "invalid_response"
  | "not_authorized"
  | "revision_changed";

export class FinanceContractError extends Error {
  constructor(readonly code: FinanceContractErrorCode) {
    super(`Finance read contract failed: ${code}`);
    this.name = "FinanceContractError";
  }
}

declare const financeDecimalBrand: unique symbol;
declare const financeIdBrand: unique symbol;
declare const financeCurrencyBrand: unique symbol;

export type CanonicalFinanceDecimal = string & {
  readonly [financeDecimalBrand]: true;
};
type BrandedId<Name extends string> = string & {
  readonly [financeIdBrand]: Name;
};
export type FinanceSpaceId = BrandedId<"space">;
export type FinanceSourceId = BrandedId<"source">;
export type FinanceDocumentId = BrandedId<"document">;
export type FinanceRevisionId = BrandedId<"revision">;
export type FinanceCaptureId = BrandedId<"capture">;
export type FinanceRecordId = BrandedId<"record">;
export type FinanceEvidenceId = BrandedId<"evidence">;
export type FinanceAccountId = BrandedId<"account">;
export type FinanceInstrumentId = BrandedId<"instrument">;
export type FinanceDatasetRevision = BrandedId<"dataset_revision">;
export type FinancePrincipalId = BrandedId<"principal">;
export type FinanceCurrency = string & {
  readonly [financeCurrencyBrand]: true;
};

export type FinanceRecordKind = "transaction" | "holding" | "balance";

export type FinanceMoney = {
  decimal: CanonicalFinanceDecimal;
  currency: FinanceCurrency;
};

/**
 * The immutable retained bytes an evidence item cites. Shared by both evidence
 * kinds: same identities, same byte length, same SHA-256 binding, one
 * definition. Not a path. The retained tree is content addressed, so
 * `retainedSha256` is what resolves the bytes.
 */
export type RetainedSourceObject = {
  sourceId: FinanceSourceId;
  documentId: FinanceDocumentId;
  revisionId: FinanceRevisionId;
  captureId: FinanceCaptureId;
  retainedSha256: string;
  retainedByteLength: number;
  mediaType:
    | "application/pdf"
    | "application/json"
    | "text/csv; charset=utf-8"
    | "text/plain; charset=utf-8";
};

export type RetainedTextSpanEvidence = {
  kind: "retained_text_span_v1";
  evidenceId: FinanceEvidenceId;
  sourceObject: RetainedSourceObject;
  locator: {
    relativePath: string;
    textSha256: string;
    textByteLength: number;
    textCodepointLength: number;
    offsetUnit: "unicode_code_points";
    start: number;
    end: number;
    quote: string;
    quoteSha256: string;
  };
};

/**
 * Exactly two formats. Each one resolves to a single scalar inside the
 * retained bytes named by `sourceObject`, and each one carries that scalar as
 * retained so a consumer can check the cited datum rather than trust it.
 */
export type StructuredFieldLocator =
  | {
      format: "json_pointer_v1";
      /** An RFC 6901 JSON Pointer resolving to a JSON string or number. */
      pointer: string;
      /** The target's exact JSON source token, quotes and escapes included. */
      rawValue: string;
      rawValueSha256: string;
    }
  | {
      format: "delimited_row_v1";
      encoding: "utf-8";
      delimiter: "," | "\t" | ";" | "|";
      quote: '"' | "none";
      headerRows: 0 | 1;
      recordSeparator: "lf" | "crlf";
      /** Zero based, over data records only, after `headerRows`. */
      rowIndex: number;
      /** Zero based, within the record. */
      columnIndex: number;
      /** The header cell at `columnIndex`. Empty only when `headerRows` is 0. */
      columnName: string;
      /** The field's text after unquoting, untrimmed, exactly as retained. */
      rawValue: string;
      rawValueSha256: string;
    };

export type StructuredFieldEvidence = {
  kind: "structured_field_v1";
  evidenceId: FinanceEvidenceId;
  sourceObject: RetainedSourceObject;
  locator: StructuredFieldLocator;
};

export type FinanceEvidence =
  RetainedTextSpanEvidence | StructuredFieldEvidence;

export type FinanceTransactionRecord = {
  recordId: FinanceRecordId;
  accountId: FinanceAccountId;
  occurredOn: string;
  activityType: string;
  description: string;
  amount: FinanceMoney;
  quantity?: CanonicalFinanceDecimal;
  price?: FinanceMoney;
  evidence: FinanceEvidence[];
};

export type FinanceHoldingRecord = {
  recordId: FinanceRecordId;
  accountId: FinanceAccountId;
  instrumentId: FinanceInstrumentId;
  asOf: string;
  quantity: CanonicalFinanceDecimal;
  price?: FinanceMoney;
  marketValue?: FinanceMoney;
  costBasis?: FinanceMoney;
  valuationBasis: "market_price" | "last_round" | "cost" | "reported_nav";
  evidence: FinanceEvidence[];
};

export type FinanceBalanceRecord = {
  recordId: FinanceRecordId;
  accountId: FinanceAccountId;
  asOf: string;
  totalValue: FinanceMoney;
  cash?: FinanceMoney;
  evidence: FinanceEvidence[];
};

export type FinanceAccountDescriptor = {
  accountId: FinanceAccountId;
  sourceId: FinanceSourceId;
  institutionName: string;
  accountLast4?: string;
  matchedAccountLast4?: string;
  displayLabel?: string;
  accountType?: string;
  baseCurrency?: FinanceCurrency;
  disclosures: Array<
    | {
        field: "baseCurrency";
        reason: "not_reported" | "unsupported_value";
      }
    | {
        field: "accountLast4";
        reason: "not_reported" | "unsupported_value" | "ambiguous_aliases";
      }
  >;
};

export type FinanceHoldingsSnapshotSelector =
  { mode: "exact"; asOf: string } | { mode: "latest"; onOrBefore?: string };

export type FinanceSnapshotValueField =
  | "quantity"
  | "price"
  | "marketValue"
  | "costBasis"
  | "storedUnrealizedGainLoss";

export type FinanceSnapshotFieldEvidence = {
  field: FinanceSnapshotValueField;
  evidence: FinanceEvidence[];
};

export type FinanceSnapshotFieldDisclosure = {
  field: FinanceSnapshotValueField | "derivedUnrealizedGainLoss";
  reason:
    | "not_reported"
    | "unsupported_value"
    | "retained_evidence_unavailable"
    | "precision_overflow";
};

/**
 * How the archive knows which instrument a position is.
 *
 * `resolved` means a real identifier (a CUSIP or an ISIN) said so.
 * `institution_symbol` means the match was made on a ticker symbol alone and
 * accepted under the archive's same-institution symbol rule: the symbol names
 * exactly one instrument, the one institution that stated the holding is also
 * the one whose own data established that instrument's identifier, and no
 * other institution's data is mixed in. It is a usable identity and it is not
 * the same fact as `resolved`, so a client citing such a position should say
 * which of the two it has. `ambiguous` means an open weak-match review item
 * still stands and the identity is not settled. `missing` means there is no
 * instrument, and no identifier is invented for one.
 */
export type FinanceSnapshotInstrumentStatus =
  | "resolved"
  | "institution_symbol"
  | "ambiguous";

export type FinanceSnapshotInstrument =
  | {
      status: FinanceSnapshotInstrumentStatus;
      instrumentId: FinanceInstrumentId;
      name?: string;
      symbol?: string;
    }
  | { status: "missing" };

export type FinanceDerivedUnrealizedGainLoss = {
  amount: FinanceMoney;
  formula: "market_value_minus_cost_basis";
};

export type FinanceHoldingsSnapshotPosition = {
  recordId: FinanceRecordId;
  accountId: FinanceAccountId;
  asOf: string;
  currency: FinanceCurrency;
  instrument: FinanceSnapshotInstrument;
  valuationBasis?: FinanceHoldingRecord["valuationBasis"];
  quantity?: CanonicalFinanceDecimal;
  price?: FinanceMoney;
  marketValue?: FinanceMoney;
  costBasis?: FinanceMoney;
  storedUnrealizedGainLoss?: FinanceMoney;
  derivedUnrealizedGainLoss?: FinanceDerivedUnrealizedGainLoss;
  fieldEvidence: FinanceSnapshotFieldEvidence[];
  disclosures: FinanceSnapshotFieldDisclosure[];
};

export type FinanceSnapshotMetricSummary = {
  amount?: FinanceMoney;
  contributingPositionCount: number;
  missingPositionCount: number;
  issue?: "precision_overflow";
};

export type FinanceSnapshotStatedAccountTotal =
  | {
      status: "available";
      amount: FinanceMoney;
      balanceRecordId: FinanceRecordId;
      evidence: FinanceEvidence[];
    }
  | {
      status: "not_reported" | "retained_evidence_unavailable" | "ambiguous";
    };

export type FinanceSnapshotReconciliation =
  | {
      status: "match" | "difference";
      difference: FinanceMoney;
      formula: "stated_account_total_minus_position_market_value";
    }
  | {
      status:
        "incomplete" | "not_available" | "ambiguous" | "precision_overflow";
    };

export type FinanceSnapshotCurrencySummary = {
  currency: FinanceCurrency;
  positionCount: number;
  marketValue: FinanceSnapshotMetricSummary;
  costBasis: FinanceSnapshotMetricSummary;
  storedUnrealizedGainLoss: FinanceSnapshotMetricSummary;
  derivedUnrealizedGainLoss: FinanceSnapshotMetricSummary;
  statedAccountTotal: FinanceSnapshotStatedAccountTotal;
  reconciliation: FinanceSnapshotReconciliation;
};

export type FinanceHoldingsSnapshotSummary =
  | {
      status: "complete" | "partial";
      positionCount: number;
      /** Positions whose instrument a CUSIP or ISIN identified. */
      resolvedInstrumentCount: number;
      /** Positions whose instrument the same-institution symbol rule accepted
       * on a ticker symbol alone. Counted apart from both other totals so a
       * reader can see, per snapshot, how much of it rests on that rule. */
      institutionSymbolInstrumentCount: number;
      /** Positions with an open weak match or no instrument at all. */
      unresolvedInstrumentCount: number;
      quantityCoverage: {
        availablePositionCount: number;
        missingPositionCount: number;
      };
      currencies: FinanceSnapshotCurrencySummary[];
    }
  | {
      status: "unavailable";
      reason: "position_limit" | "evidence_bytes_limit";
      positionCount: number;
      currencies: [];
    };

export type FinanceAggregateRecord = {
  currency: FinanceCurrency;
  accountId?: FinanceAccountId;
  total: FinanceMoney;
  contributingRecordCount: number;
  contributorRecordIds: FinanceRecordId[];
  breakdown?: {
    queryReference: string;
    cursor: string;
  };
};

export type FinanceCoverageRecord = {
  sourceId: FinanceSourceId;
  recordKind: FinanceRecordKind;
  from: string;
  toExclusive: string;
  status: "complete" | "partial" | "unknown";
  lastVerifiedAt?: number;
  gaps: Array<{
    code: "source_gap" | "pending_import" | "failed_import" | "stale_source";
    from: string;
    toExclusive: string;
  }>;
};

export type FinanceCoverageSummary =
  | { status: "complete"; asOf: number }
  | {
      status: "partial" | "unknown";
      asOf?: number;
      reasons: Array<
        | "source_gap"
        | "pending_import"
        | "failed_import"
        | "unsupported_value"
        | "retained_evidence_unavailable"
        | "missing_value"
        | "unresolved_identity"
        | "snapshot_summary_limit"
        | "snapshot_summary_evidence_limit"
        | "stale_source"
      >;
    };

export type FinanceOutputIssue =
  | {
      code: "precision_overflow";
      recordId: FinanceRecordId;
      field: string;
      sourceText: string;
      significantDigits: number;
      fractionalDigits: number;
      evidence: FinanceEvidence[];
    }
  | {
      code: "retained_evidence_unavailable";
      recordId: FinanceRecordId;
      evidence: FinanceEvidence[];
    }
  | {
      code: "snapshot_summary_limit";
      positionCount: number;
      limit: typeof MAX_FINANCE_SNAPSHOT_SUMMARY_POSITIONS;
    }
  | {
      code: "snapshot_summary_evidence_limit";
      sourceLocatorBytes: number;
      limit: typeof MAX_FINANCE_SNAPSHOT_SUMMARY_EVIDENCE_BYTES;
    };

type PageRequest = {
  contractVersion: 1;
  spaceId: FinanceSpaceId;
  limit: number;
  cursor?: string;
  expectedDatasetRevision?: FinanceDatasetRevision;
};

type DateFilters = {
  from?: string;
  toExclusive?: string;
};

export type ListTransactionsRequest = PageRequest &
  DateFilters & {
    operation: "list_transactions";
    sourceId?: FinanceSourceId;
    accountId?: FinanceAccountId;
    currency?: FinanceCurrency;
  };

export type ListHoldingsRequest = PageRequest & {
  operation: "list_holdings";
  sourceId?: FinanceSourceId;
  accountId?: FinanceAccountId;
  asOf?: string;
};

export type ListAccountsRequest = PageRequest & {
  operation: "list_accounts";
  institutionName?: string;
  accountLast4?: string;
  displayLabel?: string;
};

export type GetHoldingsSnapshotRequest = PageRequest & {
  operation: "get_holdings_snapshot";
  accountId: FinanceAccountId;
  snapshot: FinanceHoldingsSnapshotSelector;
};

export type ListBalancesRequest = PageRequest &
  DateFilters & {
    operation: "list_balances";
    sourceId?: FinanceSourceId;
    accountId?: FinanceAccountId;
  };

export type AggregateMoneyRequest = PageRequest &
  DateFilters & {
    operation: "aggregate_money";
    metric: "transaction_amount" | "market_value" | "cost_basis" | "cash";
    groupBy: "currency" | "account_currency";
    sourceId?: FinanceSourceId;
    accountId?: FinanceAccountId;
    currency?: FinanceCurrency;
  };

export type GetEvidenceRequest = PageRequest & {
  operation: "get_evidence";
  recordId: FinanceRecordId;
};

export type GetCoverageRequest = PageRequest &
  DateFilters & {
    operation: "get_coverage";
    sourceId?: FinanceSourceId;
    recordKinds?: FinanceRecordKind[];
  };

export type FinanceReadRequest =
  | ListAccountsRequest
  | GetHoldingsSnapshotRequest
  | ListTransactionsRequest
  | ListHoldingsRequest
  | ListBalancesRequest
  | AggregateMoneyRequest
  | GetEvidenceRequest
  | GetCoverageRequest;

type FinanceReadResponseBase<
  Operation extends FinanceReadRequest["operation"],
> = {
  contractVersion: 1;
  operation: Operation;
  spaceId: FinanceSpaceId;
  datasetRevision: FinanceDatasetRevision;
  coverage: FinanceCoverageSummary;
  completeness: "complete" | "partial";
  truncated: boolean;
  nextCursor?: string;
  issues: FinanceOutputIssue[];
};

export type ListTransactionsResponse =
  FinanceReadResponseBase<"list_transactions"> & {
    items: FinanceTransactionRecord[];
  };
export type ListHoldingsResponse = FinanceReadResponseBase<"list_holdings"> & {
  items: FinanceHoldingRecord[];
};
export type ListAccountsResponse = FinanceReadResponseBase<"list_accounts"> & {
  matchStatus: "none" | "unique" | "ambiguous";
  totalMatches: number;
  items: FinanceAccountDescriptor[];
};
export type GetHoldingsSnapshotResponse =
  FinanceReadResponseBase<"get_holdings_snapshot"> & {
    requestedSnapshot: FinanceHoldingsSnapshotSelector;
    selectedSnapshot:
      { status: "found"; asOf: string } | { status: "not_found" };
    account: FinanceAccountDescriptor;
    summary: FinanceHoldingsSnapshotSummary;
    items: FinanceHoldingsSnapshotPosition[];
  };
export type ListBalancesResponse = FinanceReadResponseBase<"list_balances"> & {
  items: FinanceBalanceRecord[];
};
export type AggregateMoneyResponse =
  FinanceReadResponseBase<"aggregate_money"> & {
    items: FinanceAggregateRecord[];
  };
export type GetEvidenceResponse = FinanceReadResponseBase<"get_evidence"> & {
  recordId: FinanceRecordId;
  items: FinanceEvidence[];
};
export type GetCoverageResponse = FinanceReadResponseBase<"get_coverage"> & {
  items: FinanceCoverageRecord[];
};

export type FinanceReadResponse =
  | ListAccountsResponse
  | GetHoldingsSnapshotResponse
  | ListTransactionsResponse
  | ListHoldingsResponse
  | ListBalancesResponse
  | AggregateMoneyResponse
  | GetEvidenceResponse
  | GetCoverageResponse;

export type FinanceTrustedContext = {
  principalId: FinancePrincipalId;
  authorizedSpaceIds: readonly FinanceSpaceId[];
};

export type AuthorizedFinanceRequest = {
  principalId: FinancePrincipalId;
  spaceId: FinanceSpaceId;
  request: FinanceReadRequest;
};

function fail(code: FinanceContractErrorCode): never {
  throw new FinanceContractError(code);
}

function boundedNormalizedSize<T>(
  value: T,
  maximum: number,
  code: FinanceContractErrorCode,
): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(code);
  }
  if (
    serialized === undefined ||
    encoder.encode(serialized).byteLength > maximum
  )
    fail(code);
  return value;
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function object(
  value: unknown,
  code: FinanceContractErrorCode,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: FinanceContractErrorCode,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !own(value, key)) ||
    Object.keys(value).some(
      (key) =>
        !allowed.has(key) ||
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype",
    )
  )
    fail(code);
}

function denseArray(
  value: unknown,
  minimum: number,
  maximum: number,
  code: FinanceContractErrorCode,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    fail(code);
  for (let index = 0; index < value.length; index += 1) {
    if (!own(value, String(index))) fail(code);
  }
  return Array.from(value);
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  code: FinanceContractErrorCode,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    fail(code);
  return value as number;
}

function text(
  value: unknown,
  maximumBytes: number,
  code: FinanceContractErrorCode,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0))
    fail(code);
  if (
    value.normalize("NFC") !== value ||
    encoder.encode(value).byteLength > maximumBytes
  )
    fail(code);
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  code: FinanceContractErrorCode,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail(code);
  return value as T[number];
}

function opaqueId<Name extends string>(
  value: unknown,
  code: FinanceContractErrorCode,
): BrandedId<Name> {
  const result = text(value, 128, code);
  if (!OPAQUE_ID.test(result)) fail(code);
  return result as BrandedId<Name>;
}

function sha256(value: unknown, code: FinanceContractErrorCode): string {
  const result = text(value, 64, code);
  if (!SHA256.test(result)) fail(code);
  return result;
}

function isoDate(value: unknown, code: FinanceContractErrorCode): string {
  const result = text(value, 10, code);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
  if (!match) fail(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) fail(code);
  return result;
}

function normalizedLookupText(
  value: unknown,
  code: FinanceContractErrorCode,
): string {
  if (typeof value !== "string") fail(code);
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
  if (
    normalized.length === 0 ||
    encoder.encode(normalized).byteLength > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  )
    fail(code);
  return normalized;
}

export function normalizeFinanceLookupText(value: unknown): string {
  return normalizedLookupText(value, "invalid_request");
}

function accountLast4(value: unknown, code: FinanceContractErrorCode): string {
  const result = text(value, 4, code);
  if (!/^\d{4}$/.test(result)) fail(code);
  return result;
}

function finiteTime(value: unknown, code: FinanceContractErrorCode): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  )
    fail(code);
  return value;
}

function decimalParts(value: string): {
  canonical: string;
  significantDigits: number;
  fractionalDigits: number;
} {
  const match = DECIMAL_INPUT.exec(value);
  if (!match) fail("invalid_request");
  const negative = match[1] === "-";
  const integerPart = match[2]!.replace(/^0+(?=\d)/, "");
  const fractionalPart = (match[3] ?? "").replace(/0+$/, "");
  const digits = `${integerPart}${fractionalPart}`.replace(/^0+/, "") || "0";
  const zero = digits === "0";
  return {
    canonical: `${negative && !zero ? "-" : ""}${integerPart}${
      fractionalPart ? `.${fractionalPart}` : ""
    }`,
    significantDigits: digits.length,
    fractionalDigits: fractionalPart.length,
  };
}

export function canonicalizeFinanceDecimal(
  value: unknown,
): CanonicalFinanceDecimal {
  if (typeof value !== "string" || value.length < 1 || value.length > 128)
    fail("invalid_request");
  const parts = decimalParts(value);
  if (
    parts.significantDigits > MAX_FINANCE_DECIMAL_DIGITS ||
    parts.fractionalDigits > MAX_FINANCE_DECIMAL_SCALE
  )
    fail("invalid_request");
  return parts.canonical as CanonicalFinanceDecimal;
}

export function parseCanonicalFinanceDecimal(
  value: unknown,
  code: FinanceContractErrorCode = "invalid_request",
): CanonicalFinanceDecimal {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) fail(code);
  let canonical: CanonicalFinanceDecimal;
  try {
    canonical = canonicalizeFinanceDecimal(value);
  } catch {
    fail(code);
  }
  if (canonical !== value) fail(code);
  return canonical;
}

export function parseFinanceCurrency(
  value: unknown,
  code: FinanceContractErrorCode = "invalid_request",
): FinanceCurrency {
  const result = text(value, 3, code);
  if (!supportedCurrencies.has(result)) fail(code);
  return result as FinanceCurrency;
}

export function assertCompatibleFinanceCurrencies(
  left: FinanceCurrency,
  right: FinanceCurrency,
): void {
  const parsedLeft = parseFinanceCurrency(left);
  const parsedRight = parseFinanceCurrency(right);
  if (parsedLeft !== parsedRight) fail("invalid_request");
}

function money(value: unknown, code: FinanceContractErrorCode): FinanceMoney {
  const input = object(value, code);
  exact(input, ["decimal", "currency"], [], code);
  return {
    decimal: parseCanonicalFinanceDecimal(input.decimal, code),
    currency: parseFinanceCurrency(input.currency, code),
  };
}

function relativePath(value: unknown, code: FinanceContractErrorCode): string {
  const result = text(value, 1024, code);
  if (result.startsWith("/") || result.endsWith("/") || result.includes("\\"))
    fail(code);
  const segments = result.split("/");
  if (
    segments.length < 1 ||
    segments.length > 16 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.trim() !== segment ||
        !RELATIVE_SEGMENT.test(segment),
    )
  )
    fail(code);
  return result;
}

function retainedSourceObject(
  value: unknown,
  code: FinanceContractErrorCode,
): RetainedSourceObject {
  const input = object(value, code);
  exact(
    input,
    [
      "sourceId",
      "documentId",
      "revisionId",
      "captureId",
      "retainedSha256",
      "retainedByteLength",
      "mediaType",
    ],
    [],
    code,
  );
  const mediaType = text(input.mediaType, 32, code);
  if (!MEDIA_TYPE.test(mediaType)) fail(code);
  return {
    sourceId: opaqueId<"source">(input.sourceId, code),
    documentId: opaqueId<"document">(input.documentId, code),
    revisionId: opaqueId<"revision">(input.revisionId, code),
    captureId: opaqueId<"capture">(input.captureId, code),
    retainedSha256: sha256(input.retainedSha256, code),
    retainedByteLength: integer(
      input.retainedByteLength,
      1,
      64 * 1024 * 1024,
      code,
    ),
    mediaType: mediaType as RetainedSourceObject["mediaType"],
  };
}

function textSpanLocator(
  value: unknown,
  code: FinanceContractErrorCode,
): RetainedTextSpanEvidence["locator"] {
  const locator = object(value, code);
  exact(
    locator,
    [
      "relativePath",
      "textSha256",
      "textByteLength",
      "textCodepointLength",
      "offsetUnit",
      "start",
      "end",
      "quote",
      "quoteSha256",
    ],
    [],
    code,
  );
  if (locator.offsetUnit !== "unicode_code_points") fail(code);
  const textCodepointLength = integer(
    locator.textCodepointLength,
    1,
    64 * 1024 * 1024,
    code,
  );
  const start = integer(locator.start, 0, textCodepointLength - 1, code);
  const end = integer(locator.end, start + 1, textCodepointLength, code);
  const quote = text(locator.quote, MAX_FINANCE_EVIDENCE_QUOTE_BYTES, code);
  if (Array.from(quote).length !== end - start) fail(code);
  const quoteSha256 = sha256(locator.quoteSha256, code);
  const calculatedQuoteSha256 = createHash("sha256")
    .update(quote, "utf8")
    .digest("hex");
  if (quoteSha256 !== calculatedQuoteSha256) fail(code);

  return {
    relativePath: relativePath(locator.relativePath, code),
    textSha256: sha256(locator.textSha256, code),
    textByteLength: integer(
      locator.textByteLength,
      Math.max(textCodepointLength, encoder.encode(quote).byteLength),
      64 * 1024 * 1024,
      code,
    ),
    textCodepointLength,
    offsetUnit: "unicode_code_points",
    start,
    end,
    quote,
    quoteSha256,
  };
}

/**
 * RFC 6901 syntax only. The validator cannot resolve the pointer without the
 * retained bytes, so it rejects what can never resolve to one scalar: the `-`
 * array token, a leading-zero array index, a traversal segment, a control
 * character, and a `~` that escapes nothing.
 */
function jsonPointer(value: unknown, code: FinanceContractErrorCode): string {
  const result = text(value, 1024, code);
  if (!result.startsWith("/")) fail(code);
  for (const segment of result.slice(1).split("/")) {
    if (
      !JSON_POINTER_SEGMENT.test(segment) ||
      segment === "-" ||
      segment === "." ||
      segment === ".." ||
      /^0\d+$/.test(segment)
    )
      fail(code);
  }
  return result;
}

/** Exactly one JSON string token or one JSON number token, nothing else. */
function jsonScalarToken(value: string, code: FinanceContractErrorCode): void {
  if (value.trim() !== value) fail(code);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(code);
  }
  if (typeof parsed !== "string" && typeof parsed !== "number") fail(code);
}

function boundRawValue(
  input: Record<string, unknown>,
  code: FinanceContractErrorCode,
): { rawValue: string; rawValueSha256: string } {
  const rawValue = text(input.rawValue, MAX_FINANCE_EVIDENCE_QUOTE_BYTES, code);
  const rawValueSha256 = sha256(input.rawValueSha256, code);
  if (
    rawValueSha256 !==
    createHash("sha256").update(rawValue, "utf8").digest("hex")
  )
    fail(code);
  return { rawValue, rawValueSha256 };
}

function structuredFieldLocator(
  value: unknown,
  code: FinanceContractErrorCode,
): StructuredFieldLocator {
  const locator = object(value, code);
  const format = oneOf(
    locator.format,
    ["json_pointer_v1", "delimited_row_v1"],
    code,
  );
  if (format === "json_pointer_v1") {
    exact(
      locator,
      ["format", "pointer", "rawValue", "rawValueSha256"],
      [],
      code,
    );
    const bound = boundRawValue(locator, code);
    jsonScalarToken(bound.rawValue, code);
    return { format, pointer: jsonPointer(locator.pointer, code), ...bound };
  }
  exact(
    locator,
    [
      "format",
      "encoding",
      "delimiter",
      "quote",
      "headerRows",
      "recordSeparator",
      "rowIndex",
      "columnIndex",
      "columnName",
      "rawValue",
      "rawValueSha256",
    ],
    [],
    code,
  );
  const headerRows = integer(locator.headerRows, 0, 1, code) as 0 | 1;
  const columnName = text(locator.columnName, 128, code, true);
  if ((columnName === "") !== (headerRows === 0)) fail(code);
  return {
    format,
    encoding: oneOf(locator.encoding, ["utf-8"], code),
    delimiter: oneOf(locator.delimiter, [",", "\t", ";", "|"], code),
    quote: oneOf(locator.quote, ['"', "none"], code),
    headerRows,
    recordSeparator: oneOf(locator.recordSeparator, ["lf", "crlf"], code),
    rowIndex: integer(locator.rowIndex, 0, 16_777_215, code),
    columnIndex: integer(locator.columnIndex, 0, 4095, code),
    columnName,
    ...boundRawValue(locator, code),
  };
}

function evidence(
  value: unknown,
  code: FinanceContractErrorCode,
): FinanceEvidence {
  const input = object(value, code);
  exact(input, ["kind", "evidenceId", "sourceObject", "locator"], [], code);
  const kind = oneOf(
    input.kind,
    ["retained_text_span_v1", "structured_field_v1"],
    code,
  );
  const base = {
    evidenceId: opaqueId<"evidence">(input.evidenceId, code),
    sourceObject: retainedSourceObject(input.sourceObject, code),
  };
  return kind === "retained_text_span_v1"
    ? { kind, ...base, locator: textSpanLocator(input.locator, code) }
    : { kind, ...base, locator: structuredFieldLocator(input.locator, code) };
}

function evidenceList(
  value: unknown,
  code: FinanceContractErrorCode,
): FinanceEvidence[] {
  const items = denseArray(value, 1, MAX_FINANCE_EVIDENCE_REFS, code).map(
    (item) => evidence(item, code),
  );
  if (new Set(items.map((item) => item.evidenceId)).size !== items.length)
    fail(code);
  return items;
}

function optionalId<Name extends string>(
  value: unknown,
  code: FinanceContractErrorCode,
): BrandedId<Name> | undefined {
  return value === undefined ? undefined : opaqueId<Name>(value, code);
}

function cursor(
  value: unknown,
  code: FinanceContractErrorCode,
): string | undefined {
  if (value === undefined) return undefined;
  const result = text(value, 2048, code);
  if (!CURSOR.test(result)) fail(code);
  return result;
}

function dateRange(
  input: Record<string, unknown>,
  code: FinanceContractErrorCode,
): DateFilters {
  const from = input.from === undefined ? undefined : isoDate(input.from, code);
  const toExclusive =
    input.toExclusive === undefined
      ? undefined
      : isoDate(input.toExclusive, code);
  if (from !== undefined && toExclusive !== undefined && from >= toExclusive)
    fail(code);
  return {
    ...(from === undefined ? {} : { from }),
    ...(toExclusive === undefined ? {} : { toExclusive }),
  };
}

function requestBase(input: Record<string, unknown>): PageRequest {
  if (input.contractVersion !== FINANCE_READ_CONTRACT_VERSION)
    fail("invalid_request");
  return {
    contractVersion: 1,
    spaceId: opaqueId<"space">(input.spaceId, "invalid_request"),
    limit: integer(input.limit, 1, MAX_FINANCE_PAGE_SIZE, "invalid_request"),
    ...(input.cursor === undefined
      ? {}
      : { cursor: cursor(input.cursor, "invalid_request")! }),
    ...(input.expectedDatasetRevision === undefined
      ? {}
      : {
          expectedDatasetRevision: opaqueId<"dataset_revision">(
            input.expectedDatasetRevision,
            "invalid_request",
          ),
        }),
  };
}

function parseFinanceReadRequestShape(value: unknown): FinanceReadRequest {
  const input = object(value, "invalid_request");
  const base = requestBase(input);
  const shared = ["contractVersion", "operation", "spaceId", "limit"];
  const pageOptional = ["cursor", "expectedDatasetRevision"];
  if (input.operation === "list_accounts") {
    exact(
      input,
      shared,
      [...pageOptional, "institutionName", "accountLast4", "displayLabel"],
      "invalid_request",
    );
    return {
      ...base,
      operation: "list_accounts",
      ...(input.institutionName === undefined
        ? {}
        : {
            institutionName: normalizeFinanceLookupText(input.institutionName),
          }),
      ...(input.accountLast4 === undefined
        ? {}
        : {
            accountLast4: accountLast4(input.accountLast4, "invalid_request"),
          }),
      ...(input.displayLabel === undefined
        ? {}
        : { displayLabel: normalizeFinanceLookupText(input.displayLabel) }),
    };
  }
  if (input.operation === "get_holdings_snapshot") {
    exact(
      input,
      [...shared, "accountId", "snapshot"],
      pageOptional,
      "invalid_request",
    );
    const snapshotInput = object(input.snapshot, "invalid_request");
    let snapshot: FinanceHoldingsSnapshotSelector;
    if (snapshotInput.mode === "exact") {
      exact(snapshotInput, ["mode", "asOf"], [], "invalid_request");
      snapshot = {
        mode: "exact",
        asOf: isoDate(snapshotInput.asOf, "invalid_request"),
      };
    } else {
      exact(snapshotInput, ["mode"], ["onOrBefore"], "invalid_request");
      if (snapshotInput.mode !== "latest") fail("invalid_request");
      snapshot = {
        mode: "latest",
        ...(snapshotInput.onOrBefore === undefined
          ? {}
          : {
              onOrBefore: isoDate(snapshotInput.onOrBefore, "invalid_request"),
            }),
      };
    }
    return {
      ...base,
      operation: "get_holdings_snapshot",
      accountId: opaqueId<"account">(input.accountId, "invalid_request"),
      snapshot,
    };
  }
  if (input.operation === "list_transactions") {
    exact(
      input,
      shared,
      [
        ...pageOptional,
        "sourceId",
        "accountId",
        "currency",
        "from",
        "toExclusive",
      ],
      "invalid_request",
    );
    return {
      ...base,
      operation: "list_transactions",
      ...dateRange(input, "invalid_request"),
      ...(input.sourceId === undefined
        ? {}
        : { sourceId: opaqueId<"source">(input.sourceId, "invalid_request") }),
      ...(input.accountId === undefined
        ? {}
        : {
            accountId: opaqueId<"account">(input.accountId, "invalid_request"),
          }),
      ...(input.currency === undefined
        ? {}
        : { currency: parseFinanceCurrency(input.currency) }),
    };
  }
  if (input.operation === "list_holdings") {
    exact(
      input,
      shared,
      [...pageOptional, "sourceId", "accountId", "asOf"],
      "invalid_request",
    );
    return {
      ...base,
      operation: "list_holdings",
      ...(input.sourceId === undefined
        ? {}
        : { sourceId: opaqueId<"source">(input.sourceId, "invalid_request") }),
      ...(input.accountId === undefined
        ? {}
        : {
            accountId: opaqueId<"account">(input.accountId, "invalid_request"),
          }),
      ...(input.asOf === undefined
        ? {}
        : { asOf: isoDate(input.asOf, "invalid_request") }),
    };
  }
  if (input.operation === "list_balances") {
    exact(
      input,
      shared,
      [...pageOptional, "sourceId", "accountId", "from", "toExclusive"],
      "invalid_request",
    );
    return {
      ...base,
      operation: "list_balances",
      ...dateRange(input, "invalid_request"),
      ...(input.sourceId === undefined
        ? {}
        : { sourceId: opaqueId<"source">(input.sourceId, "invalid_request") }),
      ...(input.accountId === undefined
        ? {}
        : {
            accountId: opaqueId<"account">(input.accountId, "invalid_request"),
          }),
    };
  }
  if (input.operation === "aggregate_money") {
    exact(
      input,
      [...shared, "metric", "groupBy"],
      [
        ...pageOptional,
        "sourceId",
        "accountId",
        "currency",
        "from",
        "toExclusive",
      ],
      "invalid_request",
    );
    return {
      ...base,
      operation: "aggregate_money",
      metric: oneOf(
        input.metric,
        ["transaction_amount", "market_value", "cost_basis", "cash"] as const,
        "invalid_request",
      ),
      groupBy: oneOf(
        input.groupBy,
        ["currency", "account_currency"] as const,
        "invalid_request",
      ),
      ...dateRange(input, "invalid_request"),
      ...(input.sourceId === undefined
        ? {}
        : { sourceId: opaqueId<"source">(input.sourceId, "invalid_request") }),
      ...(input.accountId === undefined
        ? {}
        : {
            accountId: opaqueId<"account">(input.accountId, "invalid_request"),
          }),
      ...(input.currency === undefined
        ? {}
        : { currency: parseFinanceCurrency(input.currency) }),
    };
  }
  if (input.operation === "get_evidence") {
    exact(input, [...shared, "recordId"], pageOptional, "invalid_request");
    return {
      ...base,
      operation: "get_evidence",
      recordId: opaqueId<"record">(input.recordId, "invalid_request"),
    };
  }
  if (input.operation === "get_coverage") {
    exact(
      input,
      shared,
      [...pageOptional, "sourceId", "recordKinds", "from", "toExclusive"],
      "invalid_request",
    );
    let recordKinds: FinanceRecordKind[] | undefined;
    if (input.recordKinds !== undefined) {
      recordKinds = denseArray(input.recordKinds, 1, 3, "invalid_request").map(
        (item) =>
          oneOf(
            item,
            ["transaction", "holding", "balance"] as const,
            "invalid_request",
          ),
      );
      if (new Set(recordKinds).size !== recordKinds.length)
        fail("invalid_request");
    }
    return {
      ...base,
      operation: "get_coverage",
      ...dateRange(input, "invalid_request"),
      ...(input.sourceId === undefined
        ? {}
        : { sourceId: opaqueId<"source">(input.sourceId, "invalid_request") }),
      ...(recordKinds === undefined ? {} : { recordKinds }),
    };
  }
  fail("invalid_request");
}

export function parseFinanceReadRequest(value: unknown): FinanceReadRequest {
  return boundedNormalizedSize(
    parseFinanceReadRequestShape(value),
    MAX_FINANCE_REQUEST_BYTES,
    "invalid_request",
  );
}

export function authorizeFinanceReadRequest(
  requestValue: unknown,
  contextValue: unknown,
): AuthorizedFinanceRequest {
  const request = parseFinanceReadRequest(requestValue);
  const context = object(contextValue, "not_authorized");
  exact(context, ["principalId", "authorizedSpaceIds"], [], "not_authorized");
  const principalId = opaqueId<"principal">(
    context.principalId,
    "not_authorized",
  );
  const authorizedSpaceIds = denseArray(
    context.authorizedSpaceIds,
    1,
    64,
    "not_authorized",
  ).map((item) => opaqueId<"space">(item, "not_authorized"));
  if (new Set(authorizedSpaceIds).size !== authorizedSpaceIds.length)
    fail("not_authorized");
  if (!authorizedSpaceIds.includes(request.spaceId)) fail("not_authorized");
  return { principalId, spaceId: request.spaceId, request };
}

function parseEvidenceBearingRecordBase(input: Record<string, unknown>): {
  recordId: FinanceRecordId;
  accountId: FinanceAccountId;
  evidence: FinanceEvidence[];
} {
  return {
    recordId: opaqueId<"record">(input.recordId, "invalid_response"),
    accountId: opaqueId<"account">(input.accountId, "invalid_response"),
    evidence: evidenceList(input.evidence, "invalid_response"),
  };
}

function transaction(value: unknown): FinanceTransactionRecord {
  const input = object(value, "invalid_response");
  exact(
    input,
    [
      "recordId",
      "accountId",
      "occurredOn",
      "activityType",
      "description",
      "amount",
      "evidence",
    ],
    ["quantity", "price"],
    "invalid_response",
  );
  return {
    ...parseEvidenceBearingRecordBase(input),
    occurredOn: isoDate(input.occurredOn, "invalid_response"),
    activityType: text(input.activityType, 128, "invalid_response"),
    description: text(input.description, 2048, "invalid_response", true),
    amount: money(input.amount, "invalid_response"),
    ...(input.quantity === undefined
      ? {}
      : {
          quantity: parseCanonicalFinanceDecimal(
            input.quantity,
            "invalid_response",
          ),
        }),
    ...(input.price === undefined
      ? {}
      : { price: money(input.price, "invalid_response") }),
  };
}

function holding(value: unknown): FinanceHoldingRecord {
  const input = object(value, "invalid_response");
  exact(
    input,
    [
      "recordId",
      "accountId",
      "instrumentId",
      "asOf",
      "quantity",
      "valuationBasis",
      "evidence",
    ],
    ["price", "marketValue", "costBasis"],
    "invalid_response",
  );
  return {
    ...parseEvidenceBearingRecordBase(input),
    instrumentId: opaqueId<"instrument">(
      input.instrumentId,
      "invalid_response",
    ),
    asOf: isoDate(input.asOf, "invalid_response"),
    quantity: parseCanonicalFinanceDecimal(input.quantity, "invalid_response"),
    valuationBasis: oneOf(
      input.valuationBasis,
      ["market_price", "last_round", "cost", "reported_nav"] as const,
      "invalid_response",
    ),
    ...(input.price === undefined
      ? {}
      : { price: money(input.price, "invalid_response") }),
    ...(input.marketValue === undefined
      ? {}
      : { marketValue: money(input.marketValue, "invalid_response") }),
    ...(input.costBasis === undefined
      ? {}
      : { costBasis: money(input.costBasis, "invalid_response") }),
  };
}

function balance(value: unknown): FinanceBalanceRecord {
  const input = object(value, "invalid_response");
  exact(
    input,
    ["recordId", "accountId", "asOf", "totalValue", "evidence"],
    ["cash"],
    "invalid_response",
  );
  return {
    ...parseEvidenceBearingRecordBase(input),
    asOf: isoDate(input.asOf, "invalid_response"),
    totalValue: money(input.totalValue, "invalid_response"),
    ...(input.cash === undefined
      ? {}
      : { cash: money(input.cash, "invalid_response") }),
  };
}

function accountDescriptor(value: unknown): FinanceAccountDescriptor {
  const input = object(value, "invalid_response");
  exact(
    input,
    ["accountId", "sourceId", "institutionName"],
    [
      "accountLast4",
      "matchedAccountLast4",
      "displayLabel",
      "accountType",
      "baseCurrency",
      "disclosures",
    ],
    "invalid_response",
  );
  const disclosures = denseArray(
    input.disclosures === undefined ? [] : input.disclosures,
    0,
    2,
    "invalid_response",
  ).map((value) => {
    const disclosure = object(value, "invalid_response");
    exact(disclosure, ["field", "reason"], [], "invalid_response");
    if (disclosure.field === "baseCurrency")
      return {
        field: "baseCurrency" as const,
        reason: oneOf(
          disclosure.reason,
          ["not_reported", "unsupported_value"] as const,
          "invalid_response",
        ),
      };
    if (disclosure.field === "accountLast4")
      return {
        field: "accountLast4" as const,
        reason: oneOf(
          disclosure.reason,
          ["not_reported", "unsupported_value", "ambiguous_aliases"] as const,
          "invalid_response",
        ),
      };
    fail("invalid_response");
  });
  if (
    new Set(disclosures.map((item) => item.field)).size !== disclosures.length
  )
    fail("invalid_response");
  const baseCurrencyDisclosure = disclosures.find(
    (item) => item.field === "baseCurrency",
  );
  const accountLast4Disclosure = disclosures.find(
    (item) => item.field === "accountLast4",
  );
  if (
    (input.baseCurrency === undefined) ===
    (baseCurrencyDisclosure === undefined)
  )
    fail("invalid_response");
  const parsedAccountLast4 =
    input.accountLast4 === undefined
      ? undefined
      : accountLast4(input.accountLast4, "invalid_response");
  const matchedAccountLast4 =
    input.matchedAccountLast4 === undefined
      ? undefined
      : accountLast4(input.matchedAccountLast4, "invalid_response");
  if (
    (parsedAccountLast4 !== undefined &&
      accountLast4Disclosure !== undefined) ||
    (matchedAccountLast4 !== undefined &&
      (parsedAccountLast4 !== undefined ||
        accountLast4Disclosure?.reason !== "ambiguous_aliases"))
  )
    fail("invalid_response");
  return {
    accountId: opaqueId<"account">(input.accountId, "invalid_response"),
    sourceId: opaqueId<"source">(input.sourceId, "invalid_response"),
    institutionName: text(input.institutionName, 256, "invalid_response"),
    ...(input.baseCurrency === undefined
      ? {}
      : {
          baseCurrency: parseFinanceCurrency(
            input.baseCurrency,
            "invalid_response",
          ),
        }),
    disclosures,
    ...(parsedAccountLast4 === undefined
      ? {}
      : { accountLast4: parsedAccountLast4 }),
    ...(matchedAccountLast4 === undefined ? {} : { matchedAccountLast4 }),
    ...(input.displayLabel === undefined
      ? {}
      : { displayLabel: text(input.displayLabel, 256, "invalid_response") }),
    ...(input.accountType === undefined
      ? {}
      : { accountType: text(input.accountType, 128, "invalid_response") }),
  };
}

function snapshotSelector(
  value: unknown,
  code: FinanceContractErrorCode,
): FinanceHoldingsSnapshotSelector {
  const input = object(value, code);
  if (input.mode === "exact") {
    exact(input, ["mode", "asOf"], [], code);
    return { mode: "exact", asOf: isoDate(input.asOf, code) };
  }
  exact(input, ["mode"], ["onOrBefore"], code);
  if (input.mode !== "latest") fail(code);
  return {
    mode: "latest",
    ...(input.onOrBefore === undefined
      ? {}
      : { onOrBefore: isoDate(input.onOrBefore, code) }),
  };
}

const SNAPSHOT_VALUE_FIELDS = [
  "quantity",
  "price",
  "marketValue",
  "costBasis",
  "storedUnrealizedGainLoss",
] as const;
const SNAPSHOT_DISCLOSURE_FIELDS = [
  ...SNAPSHOT_VALUE_FIELDS,
  "derivedUnrealizedGainLoss",
] as const;

function snapshotInstrument(value: unknown): FinanceSnapshotInstrument {
  const input = object(value, "invalid_response");
  if (input.status === "missing") {
    exact(input, ["status"], [], "invalid_response");
    return { status: "missing" };
  }
  exact(
    input,
    ["status", "instrumentId"],
    ["name", "symbol"],
    "invalid_response",
  );
  const status = oneOf(
    input.status,
    ["resolved", "institution_symbol", "ambiguous"] as const,
    "invalid_response",
  );
  return {
    status,
    instrumentId: opaqueId<"instrument">(
      input.instrumentId,
      "invalid_response",
    ),
    ...(input.name === undefined
      ? {}
      : { name: text(input.name, 512, "invalid_response") }),
    ...(input.symbol === undefined
      ? {}
      : { symbol: text(input.symbol, 128, "invalid_response") }),
  };
}

function subtractCanonicalDecimals(
  left: CanonicalFinanceDecimal,
  right: CanonicalFinanceDecimal,
): CanonicalFinanceDecimal {
  const parts = (value: string) => {
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [integerPart, fraction = ""] = unsigned.split(".");
    return { negative, integerPart: integerPart!, fraction };
  };
  const l = parts(left);
  const r = parts(right);
  const scale = Math.max(l.fraction.length, r.fraction.length);
  const scaled = (part: ReturnType<typeof parts>) => {
    const digits = `${part.integerPart}${part.fraction.padEnd(scale, "0")}`;
    const value = BigInt(digits);
    return part.negative ? -value : value;
  };
  const difference = scaled(l) - scaled(r);
  const negative = difference < 0n;
  const digits = (negative ? -difference : difference)
    .toString()
    .padStart(scale + 1, "0");
  const integerPart = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  return `${negative && difference !== 0n ? "-" : ""}${integerPart}${
    fraction ? `.${fraction}` : ""
  }` as CanonicalFinanceDecimal;
}

function snapshotPosition(value: unknown): FinanceHoldingsSnapshotPosition {
  const input = object(value, "invalid_response");
  exact(
    input,
    [
      "recordId",
      "accountId",
      "asOf",
      "currency",
      "instrument",
      "fieldEvidence",
      "disclosures",
    ],
    [
      "valuationBasis",
      "quantity",
      "price",
      "marketValue",
      "costBasis",
      "storedUnrealizedGainLoss",
      "derivedUnrealizedGainLoss",
    ],
    "invalid_response",
  );
  const fieldEvidence = denseArray(
    input.fieldEvidence,
    0,
    SNAPSHOT_VALUE_FIELDS.length,
    "invalid_response",
  ).map((value): FinanceSnapshotFieldEvidence => {
    const item = object(value, "invalid_response");
    exact(item, ["field", "evidence"], [], "invalid_response");
    return {
      field: oneOf(item.field, SNAPSHOT_VALUE_FIELDS, "invalid_response"),
      evidence: evidenceList(item.evidence, "invalid_response"),
    };
  });
  const disclosures = denseArray(
    input.disclosures,
    0,
    SNAPSHOT_DISCLOSURE_FIELDS.length,
    "invalid_response",
  ).map((value): FinanceSnapshotFieldDisclosure => {
    const item = object(value, "invalid_response");
    exact(item, ["field", "reason"], [], "invalid_response");
    return {
      field: oneOf(item.field, SNAPSHOT_DISCLOSURE_FIELDS, "invalid_response"),
      reason: oneOf(
        item.reason,
        [
          "not_reported",
          "unsupported_value",
          "retained_evidence_unavailable",
          "precision_overflow",
        ] as const,
        "invalid_response",
      ),
    };
  });
  const evidenceFields = new Set(fieldEvidence.map((item) => item.field));
  const disclosureFields = new Set(disclosures.map((item) => item.field));
  if (
    evidenceFields.size !== fieldEvidence.length ||
    disclosureFields.size !== disclosures.length
  )
    fail("invalid_response");
  for (const field of SNAPSHOT_VALUE_FIELDS) {
    const present = input[field] !== undefined;
    if (
      present !== evidenceFields.has(field) ||
      present === disclosureFields.has(field)
    )
      fail("invalid_response");
  }
  const derivedDisclosure = disclosures.find(
    (item) => item.field === "derivedUnrealizedGainLoss",
  );
  if (
    derivedDisclosure !== undefined &&
    (derivedDisclosure.reason !== "precision_overflow" ||
      input.derivedUnrealizedGainLoss !== undefined)
  )
    fail("invalid_response");
  if (
    disclosures.some(
      (item) =>
        item.field !== "derivedUnrealizedGainLoss" &&
        item.reason === "precision_overflow",
    )
  )
    fail("invalid_response");
  const currency = parseFinanceCurrency(input.currency, "invalid_response");
  const marketValue =
    input.marketValue === undefined
      ? undefined
      : money(input.marketValue, "invalid_response");
  const costBasis =
    input.costBasis === undefined
      ? undefined
      : money(input.costBasis, "invalid_response");
  if (derivedDisclosure !== undefined) {
    if (marketValue === undefined || costBasis === undefined)
      fail("invalid_response");
    let overflowed = false;
    try {
      canonicalizeFinanceDecimal(
        subtractCanonicalDecimals(marketValue.decimal, costBasis.decimal),
      );
    } catch {
      overflowed = true;
    }
    if (!overflowed) fail("invalid_response");
  }
  if (
    [
      input.price,
      input.marketValue,
      input.costBasis,
      input.storedUnrealizedGainLoss,
    ]
      .filter((item) => item !== undefined)
      .some((item) => money(item, "invalid_response").currency !== currency)
  )
    fail("invalid_response");
  let derivedUnrealizedGainLoss: FinanceDerivedUnrealizedGainLoss | undefined;
  if (input.derivedUnrealizedGainLoss !== undefined) {
    const derived = object(input.derivedUnrealizedGainLoss, "invalid_response");
    exact(derived, ["amount", "formula"], [], "invalid_response");
    if (
      derived.formula !== "market_value_minus_cost_basis" ||
      marketValue === undefined ||
      costBasis === undefined ||
      marketValue.currency !== costBasis.currency
    )
      fail("invalid_response");
    const amount = money(derived.amount, "invalid_response");
    if (
      amount.currency !== currency ||
      amount.decimal !==
        subtractCanonicalDecimals(marketValue.decimal, costBasis.decimal)
    )
      fail("invalid_response");
    derivedUnrealizedGainLoss = {
      amount,
      formula: "market_value_minus_cost_basis",
    };
  }
  return {
    recordId: opaqueId<"record">(input.recordId, "invalid_response"),
    accountId: opaqueId<"account">(input.accountId, "invalid_response"),
    asOf: isoDate(input.asOf, "invalid_response"),
    currency,
    instrument: snapshotInstrument(input.instrument),
    ...(input.valuationBasis === undefined
      ? {}
      : {
          valuationBasis: oneOf(
            input.valuationBasis,
            ["market_price", "last_round", "cost", "reported_nav"] as const,
            "invalid_response",
          ),
        }),
    ...(input.quantity === undefined
      ? {}
      : {
          quantity: parseCanonicalFinanceDecimal(
            input.quantity,
            "invalid_response",
          ),
        }),
    ...(input.price === undefined
      ? {}
      : { price: money(input.price, "invalid_response") }),
    ...(marketValue === undefined ? {} : { marketValue }),
    ...(costBasis === undefined ? {} : { costBasis }),
    ...(input.storedUnrealizedGainLoss === undefined
      ? {}
      : {
          storedUnrealizedGainLoss: money(
            input.storedUnrealizedGainLoss,
            "invalid_response",
          ),
        }),
    ...(derivedUnrealizedGainLoss === undefined
      ? {}
      : { derivedUnrealizedGainLoss }),
    fieldEvidence,
    disclosures,
  };
}

function snapshotMetric(
  value: unknown,
  currency: FinanceCurrency,
  positionCount: number,
): FinanceSnapshotMetricSummary {
  const input = object(value, "invalid_response");
  exact(
    input,
    ["contributingPositionCount", "missingPositionCount"],
    ["amount", "issue"],
    "invalid_response",
  );
  const contributingPositionCount = integer(
    input.contributingPositionCount,
    0,
    positionCount,
    "invalid_response",
  );
  const missingPositionCount = integer(
    input.missingPositionCount,
    0,
    positionCount,
    "invalid_response",
  );
  if (contributingPositionCount + missingPositionCount !== positionCount)
    fail("invalid_response");
  const amount =
    input.amount === undefined
      ? undefined
      : money(input.amount, "invalid_response");
  const issue =
    input.issue === undefined
      ? undefined
      : oneOf(input.issue, ["precision_overflow"] as const, "invalid_response");
  if (
    contributingPositionCount > 0 !==
      (amount !== undefined || issue !== undefined) ||
    (amount !== undefined && issue !== undefined) ||
    (amount !== undefined && amount.currency !== currency)
  )
    fail("invalid_response");
  return {
    ...(amount === undefined ? {} : { amount }),
    ...(issue === undefined ? {} : { issue }),
    contributingPositionCount,
    missingPositionCount,
  };
}

function snapshotCurrencySummary(
  value: unknown,
): FinanceSnapshotCurrencySummary {
  const input = object(value, "invalid_response");
  exact(
    input,
    [
      "currency",
      "positionCount",
      "marketValue",
      "costBasis",
      "storedUnrealizedGainLoss",
      "derivedUnrealizedGainLoss",
      "statedAccountTotal",
      "reconciliation",
    ],
    [],
    "invalid_response",
  );
  const currency = parseFinanceCurrency(input.currency, "invalid_response");
  const positionCount = integer(
    input.positionCount,
    0,
    MAX_FINANCE_SNAPSHOT_SUMMARY_POSITIONS,
    "invalid_response",
  );
  const marketValue = snapshotMetric(
    input.marketValue,
    currency,
    positionCount,
  );
  const costBasis = snapshotMetric(input.costBasis, currency, positionCount);
  const storedUnrealizedGainLoss = snapshotMetric(
    input.storedUnrealizedGainLoss,
    currency,
    positionCount,
  );
  const derivedUnrealizedGainLoss = snapshotMetric(
    input.derivedUnrealizedGainLoss,
    currency,
    positionCount,
  );
  const statedInput = object(input.statedAccountTotal, "invalid_response");
  let statedAccountTotal: FinanceSnapshotStatedAccountTotal;
  if (statedInput.status === "available") {
    exact(
      statedInput,
      ["status", "amount", "balanceRecordId", "evidence"],
      [],
      "invalid_response",
    );
    const amount = money(statedInput.amount, "invalid_response");
    if (amount.currency !== currency) fail("invalid_response");
    statedAccountTotal = {
      status: "available",
      amount,
      balanceRecordId: opaqueId<"record">(
        statedInput.balanceRecordId,
        "invalid_response",
      ),
      evidence: evidenceList(statedInput.evidence, "invalid_response"),
    };
  } else {
    exact(statedInput, ["status"], [], "invalid_response");
    statedAccountTotal = {
      status: oneOf(
        statedInput.status,
        ["not_reported", "retained_evidence_unavailable", "ambiguous"] as const,
        "invalid_response",
      ),
    };
  }
  const reconciliationInput = object(input.reconciliation, "invalid_response");
  let reconciliation: FinanceSnapshotReconciliation;
  if (
    reconciliationInput.status === "match" ||
    reconciliationInput.status === "difference"
  ) {
    exact(
      reconciliationInput,
      ["status", "difference", "formula"],
      [],
      "invalid_response",
    );
    const difference = money(
      reconciliationInput.difference,
      "invalid_response",
    );
    if (
      reconciliationInput.formula !==
        "stated_account_total_minus_position_market_value" ||
      difference.currency !== currency ||
      (reconciliationInput.status === "match") !==
        (difference.decimal === "0") ||
      statedAccountTotal.status !== "available" ||
      marketValue.missingPositionCount !== 0 ||
      marketValue.amount === undefined ||
      difference.decimal !==
        subtractCanonicalDecimals(
          statedAccountTotal.amount.decimal,
          marketValue.amount.decimal,
        )
    )
      fail("invalid_response");
    reconciliation = {
      status: reconciliationInput.status,
      difference,
      formula: "stated_account_total_minus_position_market_value",
    };
  } else {
    exact(reconciliationInput, ["status"], [], "invalid_response");
    const status = oneOf(
      reconciliationInput.status,
      [
        "incomplete",
        "not_available",
        "ambiguous",
        "precision_overflow",
      ] as const,
      "invalid_response",
    );
    if (
      (status === "incomplete" &&
        marketValue.missingPositionCount === 0 &&
        marketValue.amount !== undefined) ||
      (status === "ambiguous" && statedAccountTotal.status !== "ambiguous") ||
      (status === "not_available" &&
        !["not_reported", "retained_evidence_unavailable"].includes(
          statedAccountTotal.status,
        )) ||
      (status === "precision_overflow" &&
        (statedAccountTotal.status !== "available" ||
          marketValue.amount === undefined ||
          marketValue.missingPositionCount !== 0))
    )
      fail("invalid_response");
    if (status === "precision_overflow") {
      let overflowed = false;
      try {
        canonicalizeFinanceDecimal(
          subtractCanonicalDecimals(
            statedAccountTotal.status === "available"
              ? statedAccountTotal.amount.decimal
              : ("0" as CanonicalFinanceDecimal),
            marketValue.amount?.decimal ?? ("0" as CanonicalFinanceDecimal),
          ),
        );
      } catch {
        overflowed = true;
      }
      if (!overflowed) fail("invalid_response");
    }
    reconciliation = { status };
  }
  return {
    currency,
    positionCount,
    marketValue,
    costBasis,
    storedUnrealizedGainLoss,
    derivedUnrealizedGainLoss,
    statedAccountTotal,
    reconciliation,
  };
}

function snapshotSummary(value: unknown): FinanceHoldingsSnapshotSummary {
  const input = object(value, "invalid_response");
  const status = oneOf(
    input.status,
    ["complete", "partial", "unavailable"] as const,
    "invalid_response",
  );
  const positionCount = integer(
    input.positionCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "invalid_response",
  );
  if (status === "unavailable") {
    exact(
      input,
      ["status", "reason", "positionCount", "currencies"],
      [],
      "invalid_response",
    );
    const currencies = denseArray(
      input.currencies,
      0,
      0,
      "invalid_response",
    ) as [];
    const reason = oneOf(
      input.reason,
      ["position_limit", "evidence_bytes_limit"] as const,
      "invalid_response",
    );
    if (
      reason === "position_limit" &&
      positionCount <= MAX_FINANCE_SNAPSHOT_SUMMARY_POSITIONS
    )
      fail("invalid_response");
    return { status, reason, positionCount, currencies };
  }
  exact(
    input,
    [
      "status",
      "positionCount",
      "resolvedInstrumentCount",
      "institutionSymbolInstrumentCount",
      "unresolvedInstrumentCount",
      "quantityCoverage",
      "currencies",
    ],
    [],
    "invalid_response",
  );
  if (positionCount > MAX_FINANCE_SNAPSHOT_SUMMARY_POSITIONS)
    fail("invalid_response");
  const resolvedInstrumentCount = integer(
    input.resolvedInstrumentCount,
    0,
    positionCount,
    "invalid_response",
  );
  const institutionSymbolInstrumentCount = integer(
    input.institutionSymbolInstrumentCount,
    0,
    positionCount,
    "invalid_response",
  );
  const unresolvedInstrumentCount = integer(
    input.unresolvedInstrumentCount,
    0,
    positionCount,
    "invalid_response",
  );
  if (
    resolvedInstrumentCount +
      institutionSymbolInstrumentCount +
      unresolvedInstrumentCount !==
    positionCount
  )
    fail("invalid_response");
  const quantityInput = object(input.quantityCoverage, "invalid_response");
  exact(
    quantityInput,
    ["availablePositionCount", "missingPositionCount"],
    [],
    "invalid_response",
  );
  const availablePositionCount = integer(
    quantityInput.availablePositionCount,
    0,
    positionCount,
    "invalid_response",
  );
  const missingPositionCount = integer(
    quantityInput.missingPositionCount,
    0,
    positionCount,
    "invalid_response",
  );
  if (availablePositionCount + missingPositionCount !== positionCount)
    fail("invalid_response");
  const currencies = denseArray(
    input.currencies,
    0,
    32,
    "invalid_response",
  ).map(snapshotCurrencySummary);
  if (
    new Set(currencies.map((item) => item.currency)).size !== currencies.length
  )
    fail("invalid_response");
  if (
    currencies.reduce((sum, item) => sum + item.positionCount, 0) !==
    positionCount
  )
    fail("invalid_response");
  const fullyUsable =
    unresolvedInstrumentCount === 0 &&
    missingPositionCount === 0 &&
    currencies.every(
      (item) =>
        item.marketValue.missingPositionCount === 0 &&
        item.marketValue.issue === undefined &&
        item.costBasis.missingPositionCount === 0 &&
        item.costBasis.issue === undefined &&
        item.derivedUnrealizedGainLoss.missingPositionCount === 0 &&
        item.derivedUnrealizedGainLoss.issue === undefined &&
        (item.reconciliation.status === "match" ||
          item.reconciliation.status === "difference"),
    );
  if ((status === "complete") !== fullyUsable) fail("invalid_response");
  return {
    status,
    positionCount,
    resolvedInstrumentCount,
    institutionSymbolInstrumentCount,
    unresolvedInstrumentCount,
    quantityCoverage: { availablePositionCount, missingPositionCount },
    currencies,
  };
}

function aggregate(value: unknown): FinanceAggregateRecord {
  const input = object(value, "invalid_response");
  exact(
    input,
    ["currency", "total", "contributingRecordCount", "contributorRecordIds"],
    ["accountId", "breakdown"],
    "invalid_response",
  );
  const currency = parseFinanceCurrency(input.currency, "invalid_response");
  const total = money(input.total, "invalid_response");
  if (currency !== total.currency) fail("invalid_response");
  const contributingRecordCount = integer(
    input.contributingRecordCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "invalid_response",
  );
  const contributorRecordIds = denseArray(
    input.contributorRecordIds,
    0,
    MAX_FINANCE_AGGREGATE_CONTRIBUTORS,
    "invalid_response",
  ).map((item) => opaqueId<"record">(item, "invalid_response"));
  if (new Set(contributorRecordIds).size !== contributorRecordIds.length)
    fail("invalid_response");
  if (contributorRecordIds.length > contributingRecordCount)
    fail("invalid_response");
  if (contributingRecordCount === 0 && total.decimal !== "0")
    fail("invalid_response");

  let breakdown: FinanceAggregateRecord["breakdown"];
  if (input.breakdown !== undefined) {
    const value = object(input.breakdown, "invalid_response");
    exact(value, ["queryReference", "cursor"], [], "invalid_response");
    breakdown = {
      queryReference: opaqueId<"breakdown_query">(
        value.queryReference,
        "invalid_response",
      ),
      cursor: (() => {
        const parsed = cursor(value.cursor, "invalid_response");
        if (parsed === undefined) fail("invalid_response");
        return parsed;
      })(),
    };
  }
  if (
    contributingRecordCount > contributorRecordIds.length !==
    (breakdown !== undefined)
  )
    fail("invalid_response");

  return {
    currency,
    total,
    contributingRecordCount,
    contributorRecordIds,
    ...(breakdown === undefined ? {} : { breakdown }),
    ...(input.accountId === undefined
      ? {}
      : {
          accountId: opaqueId<"account">(input.accountId, "invalid_response"),
        }),
  };
}

function coverageRecord(value: unknown): FinanceCoverageRecord {
  const input = object(value, "invalid_response");
  exact(
    input,
    ["sourceId", "recordKind", "from", "toExclusive", "status", "gaps"],
    ["lastVerifiedAt"],
    "invalid_response",
  );
  const from = isoDate(input.from, "invalid_response");
  const toExclusive = isoDate(input.toExclusive, "invalid_response");
  if (from >= toExclusive) fail("invalid_response");
  const status = oneOf(
    input.status,
    ["complete", "partial", "unknown"] as const,
    "invalid_response",
  );
  const gaps = denseArray(input.gaps, 0, 32, "invalid_response").map(
    (value) => {
      const gap = object(value, "invalid_response");
      exact(gap, ["code", "from", "toExclusive"], [], "invalid_response");
      const gapFrom = isoDate(gap.from, "invalid_response");
      const gapTo = isoDate(gap.toExclusive, "invalid_response");
      if (gapFrom >= gapTo || gapFrom < from || gapTo > toExclusive)
        fail("invalid_response");
      return {
        code: oneOf(
          gap.code,
          [
            "source_gap",
            "pending_import",
            "failed_import",
            "stale_source",
          ] as const,
          "invalid_response",
        ),
        from: gapFrom,
        toExclusive: gapTo,
      };
    },
  );
  if ((status === "complete") !== (gaps.length === 0)) fail("invalid_response");
  return {
    sourceId: opaqueId<"source">(input.sourceId, "invalid_response"),
    recordKind: oneOf(
      input.recordKind,
      ["transaction", "holding", "balance"] as const,
      "invalid_response",
    ),
    from,
    toExclusive,
    status,
    gaps,
    ...(input.lastVerifiedAt === undefined
      ? {}
      : {
          lastVerifiedAt: finiteTime(input.lastVerifiedAt, "invalid_response"),
        }),
  };
}

function coverageSummary(value: unknown): FinanceCoverageSummary {
  const input = object(value, "invalid_response");
  if (input.status === "complete") {
    exact(input, ["status", "asOf"], [], "invalid_response");
    return {
      status: "complete",
      asOf: finiteTime(input.asOf, "invalid_response"),
    };
  }
  exact(input, ["status", "reasons"], ["asOf"], "invalid_response");
  const status = oneOf(
    input.status,
    ["partial", "unknown"] as const,
    "invalid_response",
  );
  const reasons = denseArray(input.reasons, 1, 16, "invalid_response").map(
    (item) =>
      oneOf(
        item,
        [
          "source_gap",
          "pending_import",
          "failed_import",
          "unsupported_value",
          "retained_evidence_unavailable",
          "missing_value",
          "unresolved_identity",
          "snapshot_summary_limit",
          "snapshot_summary_evidence_limit",
          "stale_source",
        ] as const,
        "invalid_response",
      ),
  );
  if (new Set(reasons).size !== reasons.length) fail("invalid_response");
  return {
    status,
    reasons,
    ...(input.asOf === undefined
      ? {}
      : { asOf: finiteTime(input.asOf, "invalid_response") }),
  };
}

function overflowSource(value: unknown): {
  sourceText: string;
  significantDigits: number;
  fractionalDigits: number;
} {
  const sourceText = text(value, 256, "invalid_response");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(sourceText);
  if (!match) fail("invalid_response");
  const integerPart = match[2]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const canonical = `${match[1] === "-" ? "-" : ""}${integerPart}${
    fraction ? `.${fraction}` : ""
  }`;
  if (canonical !== sourceText || sourceText === "-0") fail("invalid_response");
  const significantDigits =
    `${integerPart}${fraction}`.replace(/^0+/, "").length || 1;
  const fractionalDigits = fraction.length;
  if (
    significantDigits <= MAX_FINANCE_DECIMAL_DIGITS &&
    fractionalDigits <= MAX_FINANCE_DECIMAL_SCALE
  )
    fail("invalid_response");
  return { sourceText, significantDigits, fractionalDigits };
}

function issue(value: unknown): FinanceOutputIssue {
  const input = object(value, "invalid_response");
  if (input.code === "precision_overflow") {
    exact(
      input,
      [
        "code",
        "recordId",
        "field",
        "sourceText",
        "significantDigits",
        "fractionalDigits",
        "evidence",
      ],
      [],
      "invalid_response",
    );
    const overflow = overflowSource(input.sourceText);
    if (
      input.significantDigits !== overflow.significantDigits ||
      input.fractionalDigits !== overflow.fractionalDigits
    )
      fail("invalid_response");
    return {
      code: "precision_overflow",
      recordId: opaqueId<"record">(input.recordId, "invalid_response"),
      field: text(input.field, 128, "invalid_response"),
      ...overflow,
      evidence: evidenceList(input.evidence, "invalid_response"),
    };
  }
  if (input.code === "snapshot_summary_limit") {
    exact(input, ["code", "positionCount", "limit"], [], "invalid_response");
    const positionCount = integer(
      input.positionCount,
      MAX_FINANCE_SNAPSHOT_SUMMARY_POSITIONS + 1,
      Number.MAX_SAFE_INTEGER,
      "invalid_response",
    );
    if (input.limit !== MAX_FINANCE_SNAPSHOT_SUMMARY_POSITIONS)
      fail("invalid_response");
    return {
      code: "snapshot_summary_limit",
      positionCount,
      limit: MAX_FINANCE_SNAPSHOT_SUMMARY_POSITIONS,
    };
  }
  if (input.code === "snapshot_summary_evidence_limit") {
    exact(
      input,
      ["code", "sourceLocatorBytes", "limit"],
      [],
      "invalid_response",
    );
    const sourceLocatorBytes = integer(
      input.sourceLocatorBytes,
      MAX_FINANCE_SNAPSHOT_SUMMARY_EVIDENCE_BYTES + 1,
      Number.MAX_SAFE_INTEGER,
      "invalid_response",
    );
    if (input.limit !== MAX_FINANCE_SNAPSHOT_SUMMARY_EVIDENCE_BYTES)
      fail("invalid_response");
    return {
      code: "snapshot_summary_evidence_limit",
      sourceLocatorBytes,
      limit: MAX_FINANCE_SNAPSHOT_SUMMARY_EVIDENCE_BYTES,
    };
  }
  if (input.code !== "retained_evidence_unavailable") fail("invalid_response");
  exact(input, ["code", "recordId", "evidence"], [], "invalid_response");
  return {
    code: "retained_evidence_unavailable",
    recordId: opaqueId<"record">(input.recordId, "invalid_response"),
    evidence: evidenceList(input.evidence, "invalid_response"),
  };
}

export function parseFinanceReadResponseShape(
  value: unknown,
): FinanceReadResponse {
  const input = object(value, "invalid_response");
  const required = [
    "contractVersion",
    "operation",
    "spaceId",
    "datasetRevision",
    "coverage",
    "completeness",
    "truncated",
    "issues",
    "items",
  ];
  exact(
    input,
    required,
    [
      "nextCursor",
      "recordId",
      "matchStatus",
      "totalMatches",
      "requestedSnapshot",
      "selectedSnapshot",
      "account",
      "summary",
    ],
    "invalid_response",
  );
  if (input.contractVersion !== FINANCE_READ_CONTRACT_VERSION)
    fail("invalid_response");
  const operation = oneOf(
    input.operation,
    [
      "list_transactions",
      "list_holdings",
      "list_accounts",
      "get_holdings_snapshot",
      "list_balances",
      "aggregate_money",
      "get_evidence",
      "get_coverage",
    ] as const,
    "invalid_response",
  );
  const accountFields = ["matchStatus", "totalMatches"];
  const snapshotFields = [
    "requestedSnapshot",
    "selectedSnapshot",
    "account",
    "summary",
  ];
  if (operation === "get_evidence") {
    if (!own(input, "recordId")) fail("invalid_response");
  } else if (own(input, "recordId")) {
    fail("invalid_response");
  }
  if (
    accountFields.some((key) => own(input, key)) !==
      (operation === "list_accounts") ||
    snapshotFields.some((key) => own(input, key)) !==
      (operation === "get_holdings_snapshot")
  )
    fail("invalid_response");
  const coverage = coverageSummary(input.coverage);
  const completeness = oneOf(
    input.completeness,
    ["complete", "partial"] as const,
    "invalid_response",
  );
  if (typeof input.truncated !== "boolean") fail("invalid_response");
  const nextCursor = cursor(input.nextCursor, "invalid_response");
  const issues = denseArray(input.issues, 0, 100, "invalid_response").map(
    issue,
  );
  if (input.truncated !== (nextCursor !== undefined)) fail("invalid_response");
  if (
    completeness === "complete" &&
    (input.truncated ||
      nextCursor !== undefined ||
      coverage.status !== "complete" ||
      issues.length)
  )
    fail("invalid_response");
  if (
    completeness === "partial" &&
    !input.truncated &&
    coverage.status === "complete" &&
    issues.length === 0
  )
    fail("invalid_response");
  const common = {
    contractVersion: 1 as const,
    spaceId: opaqueId<"space">(input.spaceId, "invalid_response"),
    datasetRevision: opaqueId<"dataset_revision">(
      input.datasetRevision,
      "invalid_response",
    ),
    coverage,
    completeness,
    truncated: input.truncated,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    issues,
  };
  const items = denseArray(
    input.items,
    0,
    MAX_FINANCE_PAGE_SIZE,
    "invalid_response",
  );
  if (operation === "list_accounts") {
    const matchStatus = oneOf(
      input.matchStatus,
      ["none", "unique", "ambiguous"] as const,
      "invalid_response",
    );
    const totalMatches = integer(
      input.totalMatches,
      0,
      Number.MAX_SAFE_INTEGER,
      "invalid_response",
    );
    if (
      (matchStatus === "none" && totalMatches !== 0) ||
      (matchStatus === "unique" && totalMatches !== 1) ||
      (matchStatus === "ambiguous" && totalMatches < 2) ||
      (matchStatus === "none" && items.length !== 0) ||
      (matchStatus === "unique" && (items.length !== 1 || input.truncated)) ||
      items.length > totalMatches
    )
      fail("invalid_response");
    return boundedNormalizedSize(
      {
        ...common,
        operation,
        matchStatus,
        totalMatches,
        items: items.map(accountDescriptor),
      },
      MAX_FINANCE_RESPONSE_BYTES,
      "invalid_response",
    );
  }
  if (operation === "get_holdings_snapshot") {
    const requestedSnapshot = snapshotSelector(
      input.requestedSnapshot,
      "invalid_response",
    );
    const selectedInput = object(input.selectedSnapshot, "invalid_response");
    let selectedSnapshot: GetHoldingsSnapshotResponse["selectedSnapshot"];
    if (selectedInput.status === "found") {
      exact(selectedInput, ["status", "asOf"], [], "invalid_response");
      selectedSnapshot = {
        status: "found",
        asOf: isoDate(selectedInput.asOf, "invalid_response"),
      };
    } else {
      exact(selectedInput, ["status"], [], "invalid_response");
      if (selectedInput.status !== "not_found") fail("invalid_response");
      selectedSnapshot = { status: "not_found" };
    }
    const account = accountDescriptor(input.account);
    const summary = snapshotSummary(input.summary);
    const parsedItems = items.map(snapshotPosition);
    const expectedSummaryIssue =
      summary.status !== "unavailable"
        ? undefined
        : summary.reason === "position_limit"
          ? "snapshot_summary_limit"
          : "snapshot_summary_evidence_limit";
    if (
      (selectedSnapshot.status === "not_found" &&
        (parsedItems.length !== 0 || summary.positionCount !== 0)) ||
      (selectedSnapshot.status === "found" &&
        parsedItems.some(
          (item) =>
            item.accountId !== account.accountId ||
            item.asOf !== selectedSnapshot.asOf,
        )) ||
      (summary.status !== "complete" && completeness === "complete") ||
      (summary.status === "complete" &&
        parsedItems.some(
          (item) =>
            // F1-76 phase 3: an accepted same-institution symbol match is a
            // settled identity, so it does not by itself make a snapshot
            // incomplete. It is still reported as its own status per position.
            (item.instrument.status !== "resolved" &&
              item.instrument.status !== "institution_symbol") ||
            item.quantity === undefined ||
            item.marketValue === undefined ||
            item.costBasis === undefined ||
            item.derivedUnrealizedGainLoss === undefined,
        )) ||
      (expectedSummaryIssue !== undefined &&
        !issues.some((item) => item.code === expectedSummaryIssue))
    )
      fail("invalid_response");
    return boundedNormalizedSize(
      {
        ...common,
        operation,
        requestedSnapshot,
        selectedSnapshot,
        account,
        summary,
        items: parsedItems,
      },
      MAX_FINANCE_RESPONSE_BYTES,
      "invalid_response",
    );
  }
  if (operation === "list_transactions")
    return boundedNormalizedSize(
      { ...common, operation, items: items.map(transaction) },
      MAX_FINANCE_RESPONSE_BYTES,
      "invalid_response",
    );
  if (operation === "list_holdings")
    return boundedNormalizedSize(
      { ...common, operation, items: items.map(holding) },
      MAX_FINANCE_RESPONSE_BYTES,
      "invalid_response",
    );
  if (operation === "list_balances")
    return boundedNormalizedSize(
      { ...common, operation, items: items.map(balance) },
      MAX_FINANCE_RESPONSE_BYTES,
      "invalid_response",
    );
  if (operation === "aggregate_money")
    return boundedNormalizedSize(
      { ...common, operation, items: items.map(aggregate) },
      MAX_FINANCE_RESPONSE_BYTES,
      "invalid_response",
    );
  if (operation === "get_evidence")
    return boundedNormalizedSize(
      {
        ...common,
        operation,
        recordId: opaqueId<"record">(input.recordId, "invalid_response"),
        items: items.map((item) => evidence(item, "invalid_response")),
      },
      MAX_FINANCE_RESPONSE_BYTES,
      "invalid_response",
    );
  const coverageItems = items.map(coverageRecord);
  if (
    operation === "get_coverage" &&
    completeness === "complete" &&
    coverageItems.some((item) => item.status !== "complete")
  )
    fail("invalid_response");
  return boundedNormalizedSize(
    { ...common, operation: "get_coverage", items: coverageItems },
    MAX_FINANCE_RESPONSE_BYTES,
    "invalid_response",
  );
}

function evidenceMatchesSource(
  evidenceItems: readonly FinanceEvidence[],
  sourceId: FinanceSourceId | undefined,
): boolean {
  return (
    sourceId === undefined ||
    evidenceItems.some((item) => item.sourceObject.sourceId === sourceId)
  );
}

function dateWithinRange(value: string, filters: DateFilters): boolean {
  return (
    (filters.from === undefined || value >= filters.from) &&
    (filters.toExclusive === undefined || value < filters.toExclusive)
  );
}

function responseMatchesRequest(
  request: FinanceReadRequest,
  response: FinanceReadResponse,
): void {
  if (response.operation !== request.operation) fail("invalid_response");
  if (request.operation === "list_accounts") {
    if (response.operation !== "list_accounts") fail("invalid_response");
    if (
      response.items.some(
        (item) =>
          (request.institutionName !== undefined &&
            normalizedLookupText(item.institutionName, "invalid_response") !==
              request.institutionName) ||
          (request.accountLast4 !== undefined &&
            item.accountLast4 !== request.accountLast4 &&
            item.matchedAccountLast4 !== request.accountLast4) ||
          (request.accountLast4 === undefined &&
            item.matchedAccountLast4 !== undefined) ||
          (request.displayLabel !== undefined &&
            (item.displayLabel === undefined ||
              normalizedLookupText(item.displayLabel, "invalid_response") !==
                request.displayLabel)),
      )
    )
      fail("invalid_response");
    return;
  }
  if (request.operation === "get_holdings_snapshot") {
    if (response.operation !== "get_holdings_snapshot")
      fail("invalid_response");
    if (
      response.account.accountId !== request.accountId ||
      response.account.matchedAccountLast4 !== undefined ||
      JSON.stringify(response.requestedSnapshot) !==
        JSON.stringify(request.snapshot)
    )
      fail("invalid_response");
    if (response.selectedSnapshot.status === "found") {
      const selectedAsOf = response.selectedSnapshot.asOf;
      if (
        (request.snapshot.mode === "exact" &&
          selectedAsOf !== request.snapshot.asOf) ||
        (request.snapshot.mode === "latest" &&
          request.snapshot.onOrBefore !== undefined &&
          selectedAsOf > request.snapshot.onOrBefore) ||
        response.items.some(
          (item) =>
            item.accountId !== request.accountId || item.asOf !== selectedAsOf,
        )
      )
        fail("invalid_response");
    }
    return;
  }
  if (request.operation === "list_transactions") {
    if (response.operation !== "list_transactions") fail("invalid_response");
    if (
      response.items.some(
        (item) =>
          (request.accountId !== undefined &&
            item.accountId !== request.accountId) ||
          (request.currency !== undefined &&
            item.amount.currency !== request.currency) ||
          !dateWithinRange(item.occurredOn, request) ||
          !evidenceMatchesSource(item.evidence, request.sourceId),
      )
    )
      fail("invalid_response");
    return;
  }
  if (request.operation === "list_holdings") {
    if (response.operation !== "list_holdings") fail("invalid_response");
    if (
      response.items.some(
        (item) =>
          (request.accountId !== undefined &&
            item.accountId !== request.accountId) ||
          (request.asOf !== undefined && item.asOf > request.asOf) ||
          !evidenceMatchesSource(item.evidence, request.sourceId),
      )
    )
      fail("invalid_response");
    return;
  }
  if (request.operation === "list_balances") {
    if (response.operation !== "list_balances") fail("invalid_response");
    if (
      response.items.some(
        (item) =>
          (request.accountId !== undefined &&
            item.accountId !== request.accountId) ||
          !dateWithinRange(item.asOf, request) ||
          !evidenceMatchesSource(item.evidence, request.sourceId),
      )
    )
      fail("invalid_response");
    return;
  }
  if (request.operation === "aggregate_money") {
    if (response.operation !== "aggregate_money") fail("invalid_response");
    if (
      response.items.some(
        (item) =>
          (request.groupBy === "currency" && item.accountId !== undefined) ||
          (request.groupBy === "account_currency" &&
            item.accountId === undefined) ||
          (request.groupBy === "account_currency" &&
            request.accountId !== undefined &&
            item.accountId !== request.accountId) ||
          (request.currency !== undefined &&
            item.currency !== request.currency),
      )
    )
      fail("invalid_response");
    return;
  }
  if (request.operation === "get_evidence") {
    if (
      response.operation !== "get_evidence" ||
      response.recordId !== request.recordId
    )
      fail("invalid_response");
    return;
  }
  if (response.operation !== "get_coverage") fail("invalid_response");
  if (
    response.items.some(
      (item) =>
        (request.sourceId !== undefined &&
          item.sourceId !== request.sourceId) ||
        (request.recordKinds !== undefined &&
          !request.recordKinds.includes(item.recordKind)) ||
        (request.from !== undefined && item.from < request.from) ||
        (request.toExclusive !== undefined &&
          item.toExclusive > request.toExclusive),
    )
  )
    fail("invalid_response");
}

export function parseAuthorizedFinanceReadExchange(value: unknown): {
  authorization: AuthorizedFinanceRequest;
  response: FinanceReadResponse;
} {
  const input = object(value, "invalid_request");
  exact(
    input,
    ["request", "response", "trustedContext"],
    ["expectedDatasetRevision"],
    "invalid_request",
  );
  const authorization = authorizeFinanceReadRequest(
    input.request,
    input.trustedContext,
  );
  const response = parseFinanceReadResponseShape(input.response);
  if (
    response.spaceId !== authorization.spaceId ||
    response.items.length > authorization.request.limit
  )
    fail("invalid_response");
  responseMatchesRequest(authorization.request, response);
  if (
    authorization.request.expectedDatasetRevision !== undefined &&
    response.datasetRevision !== authorization.request.expectedDatasetRevision
  )
    fail("revision_changed");
  if (input.expectedDatasetRevision !== undefined) {
    const expectedDatasetRevision = opaqueId<"dataset_revision">(
      input.expectedDatasetRevision,
      "invalid_request",
    );
    if (response.datasetRevision !== expectedDatasetRevision)
      fail("invalid_response");
  }
  return { authorization, response };
}
