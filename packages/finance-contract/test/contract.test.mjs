import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FinanceContractError,
  MAX_FINANCE_DECIMAL_DIGITS,
  MAX_FINANCE_DECIMAL_SCALE,
  assertCompatibleFinanceCurrencies,
  authorizeFinanceReadRequest,
  canonicalizeFinanceDecimal,
  parseAuthorizedFinanceReadExchange,
  parseCanonicalFinanceDecimal,
  parseFinanceCurrency,
  parseFinanceReadRequest,
  parseFinanceReadResponseShape,
} from "../dist/index.js";
import {
  syntheticFinanceReadExchanges,
  syntheticFinanceTrustedContext,
} from "../dist/fixtures.js";

const clone = (value) => structuredClone(value);

function rejects(code, call) {
  assert.throws(call, (error) => {
    assert.ok(error instanceof FinanceContractError);
    assert.equal(error.code, code);
    return true;
  });
}

function parseExchange(exchange, overrides = {}) {
  return parseAuthorizedFinanceReadExchange({
    request: exchange.request,
    response: exchange.response,
    trustedContext: syntheticFinanceTrustedContext,
    ...overrides,
  });
}

describe("canonical finance decimals and currencies", () => {
  it("normalizes equivalent finite decimal spellings before applying limits", () => {
    assert.equal(canonicalizeFinanceDecimal("0001.2300"), "1.23");
    assert.equal(canonicalizeFinanceDecimal("-000.000"), "0");
    assert.equal(
      canonicalizeFinanceDecimal(`${"0".repeat(40)}1.001${"0".repeat(20)}`),
      "1.001",
    );
    assert.equal(
      parseCanonicalFinanceDecimal("9".repeat(MAX_FINANCE_DECIMAL_DIGITS)),
      "9".repeat(MAX_FINANCE_DECIMAL_DIGITS),
    );
  });

  it("rejects noncanonical wire decimals, numbers, exponents, and overflows", () => {
    for (const invalid of [1, NaN, Infinity, "1.0", "01", "+1", "1e2", "-0"]) {
      rejects("invalid_request", () => parseCanonicalFinanceDecimal(invalid));
    }
    rejects("invalid_request", () =>
      canonicalizeFinanceDecimal("9".repeat(MAX_FINANCE_DECIMAL_DIGITS + 1)),
    );
    rejects("invalid_request", () =>
      canonicalizeFinanceDecimal(
        `0.${"1".repeat(MAX_FINANCE_DECIMAL_SCALE + 1)}`,
      ),
    );
  });

  it("uses the bounded Phase 1 currency registry", () => {
    assert.equal(parseFinanceCurrency("USD"), "USD");
    rejects("invalid_request", () => parseFinanceCurrency("AAA"));
    rejects("invalid_request", () => parseFinanceCurrency("usd"));
    assert.doesNotThrow(() => assertCompatibleFinanceCurrencies("USD", "USD"));
    rejects("invalid_request", () =>
      assertCompatibleFinanceCurrencies("USD", "EUR"),
    );
    rejects("invalid_request", () =>
      assertCompatibleFinanceCurrencies("AAA", "AAA"),
    );
  });
});

describe("closed requests and trusted authorization", () => {
  it("accepts every operation fixture through the paired gateway validator", () => {
    assert.equal(syntheticFinanceReadExchanges.length, 6);
    for (const exchange of syntheticFinanceReadExchanges) {
      const parsed = parseExchange(exchange, {
        expectedDatasetRevision: "dataset-revision-synthetic-001",
      });
      assert.equal(parsed.response.operation, exchange.request.operation);
      assert.equal(parsed.authorization.principalId, "principal-synthetic-001");
    }
  });

  it("rejects client identity claims, malformed bounds, and sparse arrays", () => {
    const base = clone(syntheticFinanceReadExchanges[0].request);
    rejects("invalid_request", () =>
      parseFinanceReadRequest({ ...base, principalId: "principal-attacker" }),
    );
    rejects("invalid_request", () =>
      parseFinanceReadRequest({ ...base, limit: 0 }),
    );
    rejects("invalid_request", () =>
      parseFinanceReadRequest({ ...base, cursor: "short" }),
    );
    rejects("invalid_request", () =>
      parseFinanceReadRequest({ ...base, from: "2026-02-30" }),
    );
    const coverage = clone(syntheticFinanceReadExchanges[5].request);
    coverage.recordKinds = new Array(2);
    coverage.recordKinds[1] = "transaction";
    rejects("invalid_request", () => parseFinanceReadRequest(coverage));
  });

  it("derives identity from trusted context and rejects space mismatch", () => {
    const request = syntheticFinanceReadExchanges[0].request;
    rejects("not_authorized", () =>
      authorizeFinanceReadRequest(request, {
        principalId: "principal-synthetic-001",
        authorizedSpaceIds: ["space-another"],
      }),
    );
  });

  it("binds directly represented request filters to returned records", () => {
    const transaction = clone(syntheticFinanceReadExchanges[0]);
    transaction.request.accountId = "account-synthetic-001";
    transaction.response.items[0].accountId = "account-other";
    rejects("invalid_response", () => parseExchange(transaction));

    const source = clone(syntheticFinanceReadExchanges[0]);
    source.response.items[0].evidence[0].sourceObject.sourceId = "source-other";
    rejects("invalid_response", () => parseExchange(source));

    const aggregate = clone(syntheticFinanceReadExchanges[3]);
    aggregate.request.groupBy = "account_currency";
    rejects("invalid_response", () => parseExchange(aggregate));

    const accountFilteredCurrency = clone(syntheticFinanceReadExchanges[3]);
    accountFilteredCurrency.request.accountId = "account-synthetic-001";
    assert.equal(
      parseExchange(accountFilteredCurrency).response.items[0].accountId,
      undefined,
    );

    const holding = clone(syntheticFinanceReadExchanges[1]);
    holding.response.items[0].asOf = "2026-01-30";
    assert.equal(parseExchange(holding).response.items[0].asOf, "2026-01-30");
    holding.response.items[0].asOf = "2026-02-01";
    rejects("invalid_response", () => parseExchange(holding));

    const evidence = clone(syntheticFinanceReadExchanges[4]);
    evidence.response.recordId = "record-other";
    rejects("invalid_response", () => parseExchange(evidence));

    const coverage = clone(syntheticFinanceReadExchanges[5]);
    coverage.response.items[0].recordKind = "holding";
    rejects("invalid_response", () => parseExchange(coverage));
  });

  it("binds response operation, space, item count, and optional revision", () => {
    const exchange = syntheticFinanceReadExchanges[0];
    const wrongOperation = clone(exchange.response);
    wrongOperation.operation = "list_balances";
    rejects("invalid_response", () =>
      parseExchange({ request: exchange.request, response: wrongOperation }),
    );

    const request = { ...exchange.request, limit: 1 };
    const tooMany = clone(exchange.response);
    tooMany.items.push(clone(tooMany.items[0]));
    tooMany.items[1].recordId = "record-transaction-002";
    rejects("invalid_response", () =>
      parseExchange({ request, response: tooMany }),
    );
    rejects("invalid_response", () =>
      parseExchange(exchange, {
        expectedDatasetRevision: "dataset-revision-other",
      }),
    );
  });
});

describe("response truth and evidence", () => {
  it("prevents complete claims for truncated, uncovered, or issue-bearing output", () => {
    const response = clone(syntheticFinanceReadExchanges[0].response);
    response.truncated = true;
    response.nextCursor = "abcdefghijklmnop";
    rejects("invalid_response", () => parseFinanceReadResponseShape(response));

    const partialWithoutReason = clone(
      syntheticFinanceReadExchanges[0].response,
    );
    partialWithoutReason.completeness = "partial";
    rejects("invalid_response", () =>
      parseFinanceReadResponseShape(partialWithoutReason),
    );

    const missingCursor = clone(syntheticFinanceReadExchanges[0].response);
    missingCursor.completeness = "partial";
    missingCursor.truncated = true;
    rejects("invalid_response", () =>
      parseFinanceReadResponseShape(missingCursor),
    );
  });

  it("separates retained source identity from a verified text span", () => {
    const exchange = clone(syntheticFinanceReadExchanges[4]);
    const item = exchange.response.items[0];
    assert.notEqual(item.sourceObject.retainedSha256, item.locator.textSha256);
    assert.equal(
      parseExchange(exchange).response.items[0].locator.quote,
      "Synthetic fee",
    );

    item.locator.relativePath = "/private/source.pdf";
    rejects("invalid_response", () => parseExchange(exchange));
    item.locator.relativePath = "text/source.txt";
    item.locator.quoteSha256 = "c".repeat(64);
    rejects("invalid_response", () => parseExchange(exchange));
    item.locator.quoteSha256 =
      "43fbdfac59ed1754558fc7da806a600c014e16b41a263258966606c28d5d6a2c";
    item.locator.end += 1;
    rejects("invalid_response", () => parseExchange(exchange));

    const duplicate = clone(syntheticFinanceReadExchanges[0]);
    duplicate.response.items[0].evidence.push(
      clone(duplicate.response.items[0].evidence[0]),
    );
    rejects("invalid_response", () => parseExchange(duplicate));
  });

  it("requires auditable contributors or a snapshot-bound breakdown handle", () => {
    const exchange = clone(syntheticFinanceReadExchanges[3]);
    const aggregate = exchange.response.items[0];
    aggregate.contributingRecordCount = 2;
    rejects("invalid_response", () => parseExchange(exchange));
    aggregate.breakdown = {
      queryReference: "breakdown-query-synthetic-001",
      cursor: "abcdefghijklmnop",
    };
    assert.equal(
      parseExchange(exchange).response.items[0].breakdown.cursor,
      "abcdefghijklmnop",
    );
    aggregate.contributorRecordIds.push("record-transaction-001");
    rejects("invalid_response", () => parseExchange(exchange));

    const empty = clone(syntheticFinanceReadExchanges[3]);
    empty.response.items[0].contributingRecordCount = 0;
    empty.response.items[0].contributorRecordIds = [];
    rejects("invalid_response", () => parseExchange(empty));
  });

  it("rejects mismatched aggregate currencies", () => {
    const exchange = clone(syntheticFinanceReadExchanges[3]);
    exchange.response.items[0].total.currency = "EUR";
    rejects("invalid_response", () => parseExchange(exchange));
  });

  it("retains evidence for precision overflow issues", () => {
    const exchange = clone(syntheticFinanceReadExchanges[0]);
    exchange.response.items = [];
    exchange.response.coverage = {
      status: "partial",
      reasons: ["unsupported_value"],
    };
    exchange.response.completeness = "partial";
    exchange.response.issues = [
      {
        code: "precision_overflow",
        recordId: "record-transaction-overflow",
        field: "amount",
        sourceText: "9".repeat(39),
        significantDigits: 39,
        fractionalDigits: 0,
        evidence: [clone(syntheticFinanceReadExchanges[4].response.items[0])],
      },
    ];
    assert.equal(
      parseExchange(exchange).response.issues[0].code,
      "precision_overflow",
    );
    exchange.response.issues[0].sourceText = "1.25";
    exchange.response.issues[0].significantDigits = 3;
    exchange.response.issues[0].fractionalDigits = 2;
    rejects("invalid_response", () => parseExchange(exchange));
  });

  it("caps the normalized serialized response", () => {
    const exchange = clone(syntheticFinanceReadExchanges[0]);
    const evidence = exchange.response.items[0].evidence[0];
    evidence.locator.quote = "x".repeat(4096);
    evidence.locator.quoteSha256 =
      "a2e659dacb4691e887ac0139f8893d04764ee197d70fb73d3190d56113d18e3e";
    evidence.locator.start = 0;
    evidence.locator.end = 4096;
    evidence.locator.textByteLength = 4096;
    evidence.locator.textCodepointLength = 4096;
    exchange.response.items[0].description = "d".repeat(2048);
    exchange.response.items[0].evidence = Array.from(
      { length: 16 },
      (_, index) => ({
        ...clone(evidence),
        evidenceId: `evidence-large-${index}`,
      }),
    );
    exchange.response.items = Array.from({ length: 100 }, (_, index) => ({
      ...clone(exchange.response.items[0]),
      recordId: `record-transaction-${index}`,
    }));
    rejects("invalid_response", () =>
      parseFinanceReadResponseShape(exchange.response),
    );
  });
});
