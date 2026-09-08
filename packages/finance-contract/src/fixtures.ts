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
          evidence: [evidence],
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
          evidence: [evidence],
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
