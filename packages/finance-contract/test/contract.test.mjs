import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FinanceContractError,
  MAX_FINANCE_SNAPSHOT_SUMMARY_EVIDENCE_BYTES,
  MAX_FINANCE_DECIMAL_DIGITS,
  MAX_FINANCE_DECIMAL_SCALE,
  assertCompatibleFinanceCurrencies,
  authorizeFinanceReadRequest,
  canonicalizeFinanceDecimal,
  normalizeFinanceLookupText,
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
    assert.equal(syntheticFinanceReadExchanges.length, 9);
    for (const exchange of syntheticFinanceReadExchanges) {
      const parsed = parseExchange(exchange, {
        expectedDatasetRevision: "dataset-revision-synthetic-001",
      });
      assert.equal(parsed.response.operation, exchange.request.operation);
      assert.equal(parsed.authorization.principalId, "principal-synthetic-001");
    }
  });

  it("normalizes bounded account lookup text and rejects account-number-shaped input", () => {
    assert.equal(
      normalizeFinanceLookupText("  Example   Broker  "),
      "example broker",
    );
    const request = clone(syntheticFinanceReadExchanges[6].request);
    request.institutionName = "  Example   Broker ";
    request.displayLabel = " INCOME ";
    const parsed = parseFinanceReadRequest(request);
    assert.equal(parsed.institutionName, "example broker");
    assert.equal(parsed.displayLabel, "income");
    request.accountLast4 = "12345";
    rejects("invalid_request", () => parseFinanceReadRequest(request));
  });

  it("requires account disambiguation and exact snapshot selection truth", () => {
    const accounts = clone(syntheticFinanceReadExchanges[6]);
    accounts.response.matchStatus = "ambiguous";
    accounts.response.totalMatches = 2;
    accounts.response.items.push({
      ...clone(accounts.response.items[0]),
      accountId: "account-synthetic-002",
      displayLabel: "Income",
    });
    assert.equal(parseExchange(accounts).response.matchStatus, "ambiguous");
    accounts.response.matchStatus = "unique";
    rejects("invalid_response", () => parseExchange(accounts));

    const terminalPage = clone(syntheticFinanceReadExchanges[6]);
    terminalPage.request.cursor = "abcdefghijklmnop";
    terminalPage.response.matchStatus = "ambiguous";
    terminalPage.response.totalMatches = 2;
    assert.equal(parseExchange(terminalPage).response.items.length, 1);

    const snapshot = clone(syntheticFinanceReadExchanges[7]);
    snapshot.response.selectedSnapshot.asOf = "2026-07-30";
    snapshot.response.items[0].asOf = "2026-07-30";
    rejects("invalid_response", () => parseExchange(snapshot));
  });

  it("preserves account identity when base currency is unknown", () => {
    const compatible = clone(syntheticFinanceReadExchanges[6]);
    delete compatible.response.items[0].disclosures;
    assert.deepEqual(
      parseExchange(compatible).response.items[0].disclosures,
      [],
    );

    for (const index of [6, 7]) {
      const exchange = clone(syntheticFinanceReadExchanges[index]);
      const descriptor =
        index === 6 ? exchange.response.items[0] : exchange.response.account;
      delete descriptor.baseCurrency;
      descriptor.disclosures = [
        { field: "baseCurrency", reason: "not_reported" },
      ];
      const response = parseExchange(exchange).response;
      const parsed =
        response.operation === "list_accounts"
          ? response.items[0]
          : response.account;
      assert.equal(parsed.accountId, "account-synthetic-001");
      assert.equal(parsed.baseCurrency, undefined);
      assert.deepEqual(parsed.disclosures, descriptor.disclosures);
    }

    const undisclosed = clone(syntheticFinanceReadExchanges[6]);
    delete undisclosed.response.items[0].baseCurrency;
    rejects("invalid_response", () => parseExchange(undisclosed));

    const contradictory = clone(syntheticFinanceReadExchanges[6]);
    contradictory.response.items[0].disclosures = [
      { field: "baseCurrency", reason: "unsupported_value" },
    ];
    rejects("invalid_response", () => parseExchange(contradictory));
  });

  it("binds an ambiguous verified alias match without exposing its full number", () => {
    const exchange = clone(syntheticFinanceReadExchanges[6]);
    delete exchange.response.items[0].accountLast4;
    exchange.response.items[0].matchedAccountLast4 = "1234";
    exchange.response.items[0].disclosures.push({
      field: "accountLast4",
      reason: "ambiguous_aliases",
    });
    const parsed = parseExchange(exchange).response;
    assert.equal(parsed.items[0].accountLast4, undefined);
    assert.equal(parsed.items[0].matchedAccountLast4, "1234");
    assert.deepEqual(parsed.items[0].disclosures[0], {
      field: "accountLast4",
      reason: "ambiguous_aliases",
    });

    const mismatched = clone(exchange);
    mismatched.response.items[0].matchedAccountLast4 = "5678";
    rejects("invalid_response", () => parseExchange(mismatched));

    const unfiltered = clone(exchange);
    delete unfiltered.request.accountLast4;
    rejects("invalid_response", () => parseExchange(unfiltered));

    const canonicalAndMatched = clone(exchange);
    canonicalAndMatched.response.items[0].accountLast4 = "1234";
    rejects("invalid_response", () => parseExchange(canonicalAndMatched));

    const snapshot = clone(syntheticFinanceReadExchanges[7]);
    snapshot.response.account.matchedAccountLast4 = "1234";
    snapshot.response.account.disclosures.push({
      field: "accountLast4",
      reason: "ambiguous_aliases",
    });
    delete snapshot.response.account.accountLast4;
    rejects("invalid_response", () => parseExchange(snapshot));
  });

  it("pins a request to its expected dataset revision", () => {
    const exchange = clone(syntheticFinanceReadExchanges[7]);
    exchange.request.expectedDatasetRevision = "dataset-revision-other";
    rejects("revision_changed", () => parseExchange(exchange));
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

  it("requires every snapshot value to be cited or explicitly withheld", () => {
    const exchange = clone(syntheticFinanceReadExchanges[7]);
    exchange.response.items[0].disclosures =
      exchange.response.items[0].disclosures.filter(
        (item) => item.field !== "price",
      );
    rejects("invalid_response", () => parseExchange(exchange));

    const wrongDerivation = clone(syntheticFinanceReadExchanges[7]);
    wrongDerivation.response.items[0].derivedUnrealizedGainLoss.amount.decimal =
      "59";
    rejects("invalid_response", () => parseExchange(wrongDerivation));

    const forgedReconciliation = clone(syntheticFinanceReadExchanges[7]);
    forgedReconciliation.response.summary.currencies[0].reconciliation.status =
      "difference";
    forgedReconciliation.response.summary.currencies[0].reconciliation.difference.decimal =
      "1";
    rejects("invalid_response", () => parseExchange(forgedReconciliation));

    const falseComplete = clone(syntheticFinanceReadExchanges[7]);
    const cost = falseComplete.response.summary.currencies[0].costBasis;
    delete cost.amount;
    cost.contributingPositionCount = 0;
    cost.missingPositionCount = 1;
    rejects("invalid_response", () => parseExchange(falseComplete));

    const hiddenAmbiguity = clone(syntheticFinanceReadExchanges[7]);
    hiddenAmbiguity.response.items[0].instrument.status = "ambiguous";
    rejects("invalid_response", () => parseExchange(hiddenAmbiguity));

    const falseDerivedOverflow = clone(syntheticFinanceReadExchanges[7]);
    delete falseDerivedOverflow.response.items[0].derivedUnrealizedGainLoss;
    falseDerivedOverflow.response.items[0].disclosures.push({
      field: "derivedUnrealizedGainLoss",
      reason: "precision_overflow",
    });
    rejects("invalid_response", () => parseExchange(falseDerivedOverflow));

    const falseReconciliationOverflow = clone(syntheticFinanceReadExchanges[7]);
    falseReconciliationOverflow.response.summary.currencies[0].reconciliation =
      {
        status: "precision_overflow",
      };
    rejects("invalid_response", () =>
      parseExchange(falseReconciliationOverflow),
    );
  });

  it("carries an institution-symbol identity as its own state, counted apart from resolved", () => {
    // F1-76 phase 3. A match made on a ticker symbol alone and accepted under
    // the archive's same-institution symbol rule is a usable identity and is
    // not the same fact as an identifier match, so it neither reads as
    // `resolved` nor makes the snapshot incomplete.
    const exchange = clone(syntheticFinanceReadExchanges[7]);
    exchange.response.items[0].instrument.status = "institution_symbol";
    exchange.response.summary.resolvedInstrumentCount = 0;
    exchange.response.summary.institutionSymbolInstrumentCount = 1;
    assert.equal(
      parseExchange(exchange).response.items[0].instrument.status,
      "institution_symbol",
    );

    // The three counts must still add up to the position count: a summary that
    // silently dropped one would be a snapshot claiming fewer positions than
    // it returned.
    const miscounted = clone(exchange);
    miscounted.response.summary.institutionSymbolInstrumentCount = 0;
    rejects("invalid_response", () => parseExchange(miscounted));

    // And the field is required, so a producer cannot omit the number that
    // says how much of a snapshot rests on the rule.
    const omitted = clone(exchange);
    delete omitted.response.summary.institutionSymbolInstrumentCount;
    rejects("invalid_response", () => parseExchange(omitted));
  });

  it("discloses an evidence-memory bound when a snapshot summary is unavailable", () => {
    const exchange = clone(syntheticFinanceReadExchanges[7]);
    exchange.response.summary = {
      status: "unavailable",
      reason: "evidence_bytes_limit",
      positionCount: 1,
      currencies: [],
    };
    exchange.response.coverage = {
      status: "partial",
      reasons: ["snapshot_summary_evidence_limit"],
    };
    exchange.response.completeness = "partial";
    exchange.response.issues = [
      {
        code: "snapshot_summary_evidence_limit",
        sourceLocatorBytes: MAX_FINANCE_SNAPSHOT_SUMMARY_EVIDENCE_BYTES + 1,
        limit: MAX_FINANCE_SNAPSHOT_SUMMARY_EVIDENCE_BYTES,
      },
    ];
    assert.equal(
      parseExchange(exchange).response.summary.status,
      "unavailable",
    );
    exchange.response.issues = [];
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

describe("structured field evidence", () => {
  const structured = (index, mutate) => {
    const exchange = clone(syntheticFinanceReadExchanges[index]);
    mutate(exchange.response.items[0].evidence[1]);
    return exchange;
  };
  const holding = (mutate) => structured(1, mutate);
  const balance = (mutate) => structured(2, mutate);

  it("accepts both locator formats, both JSON token shapes, and CSV bytes", () => {
    const pointerItem = parseExchange(syntheticFinanceReadExchanges[1]).response
      .items[0].evidence[1];
    assert.equal(pointerItem.kind, "structured_field_v1");
    assert.equal(pointerItem.locator.pointer, "/pages/0/items/0/marketValue");
    assert.equal(pointerItem.locator.rawValue, "210");

    const delimitedItem = parseExchange(syntheticFinanceReadExchanges[2])
      .response.items[0].evidence[1];
    assert.equal(
      delimitedItem.sourceObject.mediaType,
      "text/csv; charset=utf-8",
    );
    assert.equal(delimitedItem.locator.columnName, "total_value");
    assert.equal(delimitedItem.locator.rowIndex, 0);

    const stringToken = holding((item) => {
      item.locator.rawValue = '"210"';
      item.locator.rawValueSha256 =
        "455147df5a65a39f52a96e12612ca7f850fcc024972f12a07d1ef1f6b3f307f4";
    });
    assert.equal(
      parseExchange(stringToken).response.items[0].evidence[1].locator.rawValue,
      '"210"',
    );
  });

  it("refuses an unknown kind, an unknown format, and a wrong-arm key", () => {
    rejects("invalid_response", () =>
      parseExchange(
        holding((item) => {
          item.kind = "structured_field_v2";
        }),
      ),
    );
    rejects("invalid_response", () =>
      parseExchange(
        holding((item) => {
          item.locator.format = "json_pointer_v2";
        }),
      ),
    );
    rejects("invalid_response", () =>
      parseExchange(
        holding((item) => {
          item.locator.rowIndex = 0;
        }),
      ),
    );
    rejects("invalid_response", () =>
      parseExchange(
        balance((item) => {
          delete item.locator.columnIndex;
        }),
      ),
    );
  });

  it("refuses an unbound value, an unresolvable pointer, and an empty list", () => {
    rejects("invalid_response", () =>
      parseExchange(
        holding((item) => {
          item.locator.rawValueSha256 = "c".repeat(64);
        }),
      ),
    );
    rejects("invalid_response", () =>
      parseExchange(
        holding((item) => {
          item.locator.rawValue = "true";
          item.locator.rawValueSha256 =
            "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b";
        }),
      ),
    );
    for (const pointer of [
      "/pages/-/items/0/marketValue",
      "/pages/01/items/0/marketValue",
      "pages/0/items/0/marketValue",
      "/pages/~2/items/0/marketValue",
    ]) {
      rejects("invalid_response", () =>
        parseExchange(
          holding((item) => {
            item.locator.pointer = pointer;
          }),
        ),
      );
    }
    rejects("invalid_response", () =>
      parseExchange(
        balance((item) => {
          item.locator.headerRows = 0;
        }),
      ),
    );

    const empty = clone(syntheticFinanceReadExchanges[1]);
    empty.response.items[0].evidence = [];
    rejects("invalid_response", () => parseExchange(empty));
  });
});

// --- ADM-2: list_account_inventory -----------------------------------------

describe("list_account_inventory (ADM-2)", () => {
  const inventory = () => clone(syntheticFinanceReadExchanges[8]);

  it("takes no filters", () => {
    rejects("invalid_request", () =>
      parseFinanceReadRequest({
        contractVersion: 1,
        spaceId: "space-synthetic-001",
        limit: 10,
        operation: "list_account_inventory",
        accountLast4: "1234",
      }),
    );
  });

  it("refuses a row that claims it matched a last-four filter", () => {
    const exchange = inventory();
    exchange.response.items[0].account.matchedAccountLast4 = "1234";
    rejects("invalid_response", () => parseExchange(exchange));
  });

  it("refuses activity that ends before it began", () => {
    const exchange = inventory();
    exchange.response.items[0].activityFrom = "2026-08-01";
    rejects("invalid_response", () => parseExchange(exchange));
  });

  it("refuses one endpoint without the other", () => {
    const exchange = inventory();
    delete exchange.response.items[0].activityTo;
    rejects("invalid_response", () => parseExchange(exchange));
  });

  it("refuses a snapshot outside the activity the same row reports", () => {
    const exchange = inventory();
    exchange.response.items[0].latestSnapshotAsOf = "2026-09-30";
    rejects("invalid_response", () => parseExchange(exchange));

    const unranged = inventory();
    unranged.response.items[1].latestSnapshotAsOf = "2026-07-31";
    rejects("invalid_response", () => parseExchange(unranged));
  });

  it("refuses a negative count", () => {
    const exchange = inventory();
    exchange.response.items[0].openReviewCount = -1;
    rejects("invalid_response", () => parseExchange(exchange));
  });

  it("carries a current value with its currency and date, and refuses a malformed one", () => {
    const parsed = parseExchange(inventory());
    assert.deepEqual(parsed.response.items[0].currentValue, {
      value: { decimal: "1250.5", currency: "USD" },
      asOf: "2026-07-31",
      source: "positions",
    });
    assert.equal(parsed.response.items[1].currentValue, undefined);

    const badSource = inventory();
    badSource.response.items[0].currentValue.source = "estimate";
    rejects("invalid_response", () => parseExchange(badSource));

    const extra = inventory();
    extra.response.items[0].currentValue.note = "x";
    rejects("invalid_response", () => parseExchange(extra));
  });

  it("keeps an empty account's row, with no dates rather than invented ones", () => {
    const parsed = parseExchange(inventory());
    assert.equal(parsed.response.items.length, 2);
    const empty = parsed.response.items[1];
    assert.equal(empty.statementCount, 0);
    assert.equal(empty.activityFrom, undefined);
    assert.equal(empty.latestSnapshotAsOf, undefined);
  });
});
