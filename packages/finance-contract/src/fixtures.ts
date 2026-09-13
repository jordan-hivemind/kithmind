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

function syntheticJsonFieldEvidence(
  evidenceId: string,
  pointer: string,
  rawValue: string,
  rawValueSha256: string,
) {
  return {
    ...jsonFieldEvidence,
    evidenceId,
    locator: {
      ...jsonFieldEvidence.locator,
      pointer,
      rawValue,
      rawValueSha256,
    },
  } as const;
}

const quantityEvidence = syntheticJsonFieldEvidence(
  "evidence-synthetic-quantity-001",
  "/pages/0/items/0/quantity",
  "10.5",
  "80b8062fef2cf5ac9caf4e26bb153218a1c9e27f2200942d1f0a91a9354034d3",
);
const costBasisEvidence = syntheticJsonFieldEvidence(
  "evidence-synthetic-cost-basis-001",
  "/pages/0/items/0/costBasis",
  "150",
  "9ae2bdd7beedc2e766c6b76585530e16925115707dc7a06ab5ee4aa2776b2c7b",
);

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
  {
    request: {
      ...requestBase,
      operation: "list_accounts",
      institutionName: "example broker",
      accountLast4: "1234",
      displayLabel: "income",
    },
    response: {
      ...responseBase,
      operation: "list_accounts",
      matchStatus: "unique",
      totalMatches: 1,
      items: [
        {
          accountId: "account-synthetic-001",
          sourceId: "source-synthetic-001",
          institutionName: "Example Broker",
          accountLast4: "1234",
          displayLabel: "Income",
          accountType: "brokerage",
          baseCurrency: "USD",
          disclosures: [],
        },
      ],
    },
  },
  {
    request: {
      ...requestBase,
      operation: "get_holdings_snapshot",
      accountId: "account-synthetic-001",
      snapshot: { mode: "exact", asOf: "2026-07-31" },
    },
    response: {
      ...responseBase,
      operation: "get_holdings_snapshot",
      requestedSnapshot: { mode: "exact", asOf: "2026-07-31" },
      selectedSnapshot: { status: "found", asOf: "2026-07-31" },
      account: {
        accountId: "account-synthetic-001",
        sourceId: "source-synthetic-001",
        institutionName: "Example Broker",
        accountLast4: "1234",
        displayLabel: "Income",
        accountType: "brokerage",
        baseCurrency: "USD",
        disclosures: [],
      },
      summary: {
        status: "complete",
        positionCount: 1,
        resolvedInstrumentCount: 1,
        unresolvedInstrumentCount: 0,
        quantityCoverage: {
          availablePositionCount: 1,
          missingPositionCount: 0,
        },
        currencies: [
          {
            currency: "USD",
            positionCount: 1,
            marketValue: {
              amount: { decimal: "210", currency: "USD" },
              contributingPositionCount: 1,
              missingPositionCount: 0,
            },
            costBasis: {
              amount: { decimal: "150", currency: "USD" },
              contributingPositionCount: 1,
              missingPositionCount: 0,
            },
            storedUnrealizedGainLoss: {
              contributingPositionCount: 0,
              missingPositionCount: 1,
            },
            derivedUnrealizedGainLoss: {
              amount: { decimal: "60", currency: "USD" },
              contributingPositionCount: 1,
              missingPositionCount: 0,
            },
            statedAccountTotal: {
              status: "available",
              amount: { decimal: "210", currency: "USD" },
              balanceRecordId: "record-balance-synthetic-001",
              evidence: [jsonFieldEvidence],
            },
            reconciliation: {
              status: "match",
              difference: { decimal: "0", currency: "USD" },
              formula: "stated_account_total_minus_position_market_value",
            },
          },
        ],
      },
      items: [
        {
          recordId: "record-holding-snapshot-001",
          accountId: "account-synthetic-001",
          asOf: "2026-07-31",
          currency: "USD",
          instrument: {
            status: "resolved",
            instrumentId: "instrument-synthetic-001",
            name: "Synthetic Income Fund",
            symbol: "SIF",
          },
          valuationBasis: "market_price",
          quantity: "10.5",
          marketValue: { decimal: "210", currency: "USD" },
          costBasis: { decimal: "150", currency: "USD" },
          derivedUnrealizedGainLoss: {
            amount: { decimal: "60", currency: "USD" },
            formula: "market_value_minus_cost_basis",
          },
          fieldEvidence: [
            { field: "quantity", evidence: [quantityEvidence] },
            { field: "marketValue", evidence: [jsonFieldEvidence] },
            { field: "costBasis", evidence: [costBasisEvidence] },
          ],
          disclosures: [
            { field: "price", reason: "not_reported" },
            {
              field: "storedUnrealizedGainLoss",
              reason: "not_reported",
            },
          ],
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
