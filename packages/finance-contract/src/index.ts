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
const CURSOR = /^[A-Za-z0-9_-]{16,2048}$/;
const RELATIVE_SEGMENT = /^[^/\\\u0000-\u001f\u007f]{1,128}$/u;
const MEDIA_TYPE =
  /^(?:application\/pdf|application\/json|text\/csv; charset=utf-8|text\/plain; charset=utf-8)$/;
const JSON_POINTER_SEGMENT = /^(?:[^~\u0000-\u001f\u007f]|~[01])*$/u;
const CANONICAL_DECIMAL =
  /^(?:0|-?(?:[1-9]\d*|0\.\d*[1-9]|[1-9]\d*\.\d*[1-9]))$/;
const DECIMAL_INPUT = /^(-?)(\d+)(?:\.(\d+))?$/;
const supportedCurrencies = new Set<string>(SUPPORTED_FINANCE_CURRENCIES);

export type FinanceContractErrorCode =
  "invalid_request" | "invalid_response" | "not_authorized";

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
    };

type PageRequest = {
  contractVersion: 1;
  spaceId: FinanceSpaceId;
  limit: number;
  cursor?: string;
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
  };
}

function parseFinanceReadRequestShape(value: unknown): FinanceReadRequest {
  const input = object(value, "invalid_request");
  const base = requestBase(input);
  const shared = ["contractVersion", "operation", "spaceId", "limit"];
  const pageOptional = ["cursor"];
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
  exact(input, required, ["nextCursor", "recordId"], "invalid_response");
  if (input.contractVersion !== FINANCE_READ_CONTRACT_VERSION)
    fail("invalid_response");
  const operation = oneOf(
    input.operation,
    [
      "list_transactions",
      "list_holdings",
      "list_balances",
      "aggregate_money",
      "get_evidence",
      "get_coverage",
    ] as const,
    "invalid_response",
  );
  if (operation === "get_evidence") {
    if (!own(input, "recordId")) fail("invalid_response");
  } else if (own(input, "recordId")) {
    fail("invalid_response");
  }
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
