const evidence = {
  kind: "retained_text_span_v1",
  evidenceId: "evidence-synthetic-001",
  sourceObject: {
    sourceId: "source-synthetic-001",
    documentId: "document-synthetic-001",
    revisionId: "revision-synthetic-001",
    captureId: "capture-synthetic-001",
    retainedSha256:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    retainedByteLength: 4096,
    mediaType: "application/pdf",
  },
  locator: {
    relativePath:
      "archive/v1/space-synthetic-001/text/bb/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.txt",
    textSha256:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    textByteLength: 200,
    textCodepointLength: 200,
    offsetUnit: "unicode_code_points",
    start: 10,
    end: 23,
    quote: "Synthetic fee",
    quoteSha256:
      "43fbdfac59ed1754558fc7da806a600c014e16b41a263258966606c28d5d6a2c",
  },
} as const;

const jsonFieldEvidence = {
  kind: "structured_field_v1",
  evidenceId: "evidence-synthetic-002",
  sourceObject: {
    sourceId: "source-synthetic-001",
    documentId: "document-synthetic-002",
    revisionId: "revision-synthetic-002",
    captureId: "capture-synthetic-002",
    retainedSha256:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    retainedByteLength: 512,
    mediaType: "application/json",
  },
  locator: {
    format: "json_pointer_v1",
    pointer: "/pages/0/items/0/marketValue",
    rawValue: "210",
    rawValueSha256:
      "d29d53701d3c859e29e1b90028eec1ca8e2f29439198b6e036c60951fb458aa1",
  },
} as const;

const delimitedFieldEvidence = {
  kind: "structured_field_v1",
  evidenceId: "evidence-synthetic-003",
  sourceObject: {
    sourceId: "source-synthetic-001",
    documentId: "document-synthetic-003",
    revisionId: "revision-synthetic-003",
    captureId: "capture-synthetic-003",
    retainedSha256:
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    retainedByteLength: 256,
    mediaType: "text/csv; charset=utf-8",
  },
  locator: {
    format: "delimited_row_v1",
    encoding: "utf-8",
    delimiter: ",",
    quote: "none",
    headerRows: 1,
    recordSeparator: "lf",
    rowIndex: 0,
    columnIndex: 3,
    columnName: "total_value",
    rawValue: "210",
    rawValueSha256:
      "d29d53701d3c859e29e1b90028eec1ca8e2f29439198b6e036c60951fb458aa1",
  },
} as const;

const requestBase = {
  contractVersion: 1,
  spaceId: "space-synthetic-001",
  limit: 10,
} as const;

const responseBase = {
  contractVersion: 1,
  spaceId: "space-synthetic-001",
  datasetRevision: "dataset-revision-synthetic-001",
  coverage: { status: "complete", asOf: 1_788_800_000_000 },
  completeness: "complete",
  truncated: false,
  issues: [],
} as const;

export const syntheticFinanceTrustedContext = {
  principalId: "principal-synthetic-001",
  authorizedSpaceIds: ["space-synthetic-001"],
} as const;

export const syntheticFinanceReadExchanges = [
  {
    request: {
      ...requestBase,
      operation: "list_transactions",
      sourceId: "source-synthetic-001",
      from: "2026-01-01",
      toExclusive: "2026-02-01",
      currency: "USD",
    },
    response: {
      ...responseBase,
      operation: "list_transactions",
      items: [
        {
          recordId: "record-transaction-001",
          accountId: "account-synthetic-001",
          occurredOn: "2026-01-15",
          activityType: "fee",
          description: "Synthetic account fee",
          amount: { decimal: "-12.34", currency: "USD" },
          evidence: [evidence],
        },
      ],
    },
  },
  {
    request: {
      ...requestBase,
      operation: "list_holdings",
      accountId: "account-synthetic-001",
      asOf: "2026-01-31",
    },
    response: {
      ...responseBase,
      operation: "list_holdings",
      items: [
        {
          recordId: "record-holding-001",
          accountId: "account-synthetic-001",
          instrumentId: "instrument-synthetic-001",
          asOf: "2026-01-31",
          quantity: "10.5",
          price: { decimal: "20", currency: "USD" },
          marketValue: { decimal: "210", currency: "USD" },
          valuationBasis: "market_price",
          evidence: [evidence, jsonFieldEvidence],
        },
      ],
    },
  },
  {
    request: {
      ...requestBase,
      operation: "list_balances",
      accountId: "account-synthetic-001",
    },
    response: {
      ...responseBase,
      operation: "list_balances",
      items: [
        {
          recordId: "record-balance-001",
          accountId: "account-synthetic-001",
          asOf: "2026-01-31",
          totalValue: { decimal: "210", currency: "USD" },
          cash: { decimal: "25", currency: "USD" },
          evidence: [evidence, delimitedFieldEvidence],
        },
      ],
    },
  },
  {
    request: {
      ...requestBase,
      operation: "aggregate_money",
      metric: "transaction_amount",
      groupBy: "currency",
      currency: "USD",
    },
    response: {
      ...responseBase,
      operation: "aggregate_money",
      items: [
        {
          currency: "USD",
          total: { decimal: "-12.34", currency: "USD" },
          contributingRecordCount: 1,
          contributorRecordIds: ["record-transaction-001"],
        },
      ],
    },
  },
  {
    request: {
      ...requestBase,
      operation: "get_evidence",
      recordId: "record-transaction-001",
    },
    response: {
      ...responseBase,
      operation: "get_evidence",
      recordId: "record-transaction-001",
      items: [evidence],
    },
  },
  {
    request: {
      ...requestBase,
      operation: "get_coverage",
      recordKinds: ["transaction"],
      from: "2026-01-01",
      toExclusive: "2026-02-01",
    },
    response: {
      ...responseBase,
      operation: "get_coverage",
      items: [
        {
          sourceId: "source-synthetic-001",
          recordKind: "transaction",
          from: "2026-01-01",
          toExclusive: "2026-02-01",
          status: "complete",
          lastVerifiedAt: 1_788_800_000_000,
          gaps: [],
        },
      ],
    },
  },
] as const;

export const syntheticRetainedTextSpanEvidence = evidence;
export const syntheticStructuredFieldEvidence = {
  jsonPointer: jsonFieldEvidence,
  delimitedRow: delimitedFieldEvidence,
} as const;
