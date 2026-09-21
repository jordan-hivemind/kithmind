import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  actOnFinanceReviewItem,
  getFinanceReviewItem,
  listFinanceReviewItems,
} from "../dist/index.js";

import { archive, one, skip } from "./helpers/pgArchive.mjs";

const LOCATOR = JSON.stringify({
  format: "retained_text_span_v1",
  textSha256: "placeholder",
  textByteLength: 19,
  textCodepointLength: 19,
  start: 8,
  end: 14,
  quote: "123.45",
});

async function seed(client) {
  await client.query(
    `INSERT INTO institutions (id, name, slug)
     VALUES ('inst-review', 'Synthetic Review Bank', 'synthetic-review-bank')`,
  );
  await client.query(
    `INSERT INTO accounts
       (id, institution_id, external_key, acct_last4, display_name, account_type, base_currency)
     VALUES
       ('acct-fallback', 'inst-review', 'api-fallback', '1001', 'Fallback account', 'brokerage', 'USD'),
       ('acct-target', 'inst-review', 'api-target', '2002', 'Target account', 'brokerage', 'USD')`,
  );
  await client.query(
    `INSERT INTO instruments (id, symbol, cusip, name, instrument_kind, asset_class)
     VALUES ('instrument-candidate', 'SYN', '123456AA1', 'Synthetic Security', 'fund', 'equity')`,
  );
  await client.query(
    `INSERT INTO instrument_identifier_sources (instrument_id, institution_id)
     VALUES ('instrument-candidate', 'inst-review')`,
  );

  const text = "Amount: 123.45 USD";
  const bytes = Buffer.from(text, "utf8");
  const textSha = createHash("sha256").update(bytes).digest("hex");
  const locator = LOCATOR.replace("placeholder", textSha);
  await client.query(
    `INSERT INTO retained_texts (sha256, byte_length, codepoint_length, content)
     VALUES ($1, $2, $3, $4)`,
    [textSha, bytes.byteLength, Array.from(text).length, bytes],
  );
  await client.query(
    `INSERT INTO documents
       (id, institution_id, account_id, doc_type, doc_date, file_path, sha256, parsed_ok)
     VALUES
       ('doc-review', 'inst-review', 'acct-fallback', 'statement', DATE '2026-01-31',
        'synthetic/doc-review.pdf', $1, true),
       ('doc-weak', 'inst-review', 'acct-target', 'statement', DATE '2026-02-28',
        'synthetic/doc-weak.pdf', $2, true)`,
    ["a".repeat(64), "b".repeat(64)],
  );
  await client.query(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, description, amount, currency,
        source_document_id, source_locator, row_hash, imported_at)
     VALUES
       ('txn-safeguarded', 'acct-fallback', DATE '2026-01-31', 'reinvest',
        'Synthetic noncash row', NULL, 'USD', 'doc-review', $1, 'hash-safeguarded', now()),
       ('txn-correct-account', 'acct-target', DATE '2026-01-31', 'fee',
        'Synthetic correctly attributed row', '1.00', 'USD', 'doc-review', $2,
        'hash-correct-account', now())`,
    [locator, "account-row:1"],
  );
  await client.query(
    `INSERT INTO positions
       (id, account_id, as_of, instrument_id, quantity, market_value, currency,
        valuation_basis, source_document_id, source_locator, row_hash)
     VALUES ('position-weak', 'acct-target', DATE '2026-02-28',
             'instrument-candidate', '2', '20', 'USD', 'market_price',
             'doc-weak', 'position:1', 'hash-position-weak')`,
  );
  await client.query(
    `INSERT INTO review_items
       (id, kind, account_id, source_document_id, source_locator, raw_value, reason,
        institution_id, matched_instrument_id, occurrence_count, last_seen_document_id)
     VALUES
       ('review-cash', 'cash_on_noncash_activity', 'acct-fallback', 'doc-review', $1,
        '123.45', 'cash was withheld from a noncash activity', NULL, NULL, NULL, NULL),
       ('review-key-legacy', 'unknown_account_key', 'acct-fallback', NULL, NULL,
        'printed-key-2002', 'unknown source key used fallback account', NULL, NULL, NULL, NULL),
       ('review-key-correct', 'unknown_account_key', 'acct-fallback', 'doc-review',
        'account-row:1', 'printed-key-2002', 'unknown source key used fallback account',
        NULL, NULL, NULL, NULL),
       ('review-weak', 'weak_instrument_match', NULL, 'doc-weak', NULL,
        $2, 'symbol-only descriptor matched an existing instrument',
        'inst-review', 'instrument-candidate', 3, 'doc-weak'),
       ('review-unparsed', 'document_unparsed', 'acct-fallback', 'doc-review', NULL,
        'statement', 'the retained document could not be parsed', NULL, NULL, NULL, NULL)`,
    [locator, JSON.stringify({ symbol: "SYN", name: "Source spelling" })],
  );
  return { locator };
}

test(
  "review inspection filters and paginates while detail returns canonical and retained evidence",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    const first = await listFinanceReviewItems(client, {
      accountId: "acct-fallback",
      status: "open",
      limit: 2,
    });
    assert.equal(first.items.length, 2);
    assert.notEqual(first.nextCursor, null);
    const second = await listFinanceReviewItems(client, {
      accountId: "acct-fallback",
      status: "open",
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.ok(second.items.length >= 1);
    assert.equal(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
      first.items.length + second.items.length,
    );

    const cash = await getFinanceReviewItem(client, "review-cash");
    assert.equal(cash.item.guidance.category, "acknowledge");
    assert.equal(cash.canonicalRows.length, 1);
    assert.equal(cash.canonicalRows[0].values.amount, null);
    assert.equal(
      cash.evidence.length,
      2,
      "item and canonical row both retain the binding",
    );
    assert.deepEqual(cash.evidence[0].retainedText, {
      available: true,
      verified: true,
      quote: "123.45",
      truncated: false,
    });

    const weak = await getFinanceReviewItem(client, "review-weak");
    assert.equal(weak.instrumentCandidates[0].id, "instrument-candidate");
    assert.deepEqual(
      weak.instrumentCandidates[0].identifierSourceInstitutionIds,
      ["inst-review"],
    );
    assert.equal(weak.canonicalRows[0].instrumentId, "instrument-candidate");

    const unparsed = await getFinanceReviewItem(client, "review-unparsed");
    assert.equal(unparsed.item.guidance.category, "external_action");
    assert.match(unparsed.item.guidance.nextAction, /reimport/i);
    assert.deepEqual(unparsed.item.guidance.actionKinds, ["dismiss"]);
  },
);

test(
  "actions confirm an existing instrument link and acknowledge only a verified safeguard",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const now = new Date("2026-09-20T12:00:00.000Z");

    const confirmed = await actOnFinanceReviewItem(
      client,
      {
        kind: "confirm_instrument_match",
        reviewItemId: "review-weak",
        matchedInstrumentId: "instrument-candidate",
        note: "retained statement and identifiers agree",
      },
      now,
    );
    assert.equal(confirmed.status, "resolved");
    assert.equal(confirmed.canonicalRowsChanged, 0);
    assert.match(confirmed.description, /already used it/);

    const acknowledged = await actOnFinanceReviewItem(
      client,
      {
        kind: "acknowledge_safeguard",
        reviewItemId: "review-cash",
      },
      now,
    );
    assert.equal(acknowledged.status, "resolved");
    assert.match(acknowledged.description, /amount NULL/);
    assert.equal(
      (
        await one(
          client,
          "SELECT amount::text AS amount FROM transactions WHERE id = 'txn-safeguarded'",
        )
      ).amount,
      null,
    );
  },
);

test(
  "account mapping is institution-scoped and leaves unverifiable legacy attribution open",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const now = new Date("2026-09-20T12:00:00.000Z");

    const legacy = await actOnFinanceReviewItem(
      client,
      {
        kind: "map_account_key",
        reviewItemId: "review-key-legacy",
        targetAccountId: "acct-target",
        aliasKind: "statement_number",
      },
      now,
    );
    assert.equal(legacy.mappingSaved, true);
    assert.equal(legacy.accountAliasesCreated, 1);
    assert.equal(legacy.existingRowsRepaired, 0);
    assert.equal(legacy.status, "open");
    assert.match(legacy.remainingAction, /reattribute-accounts/);
    assert.equal(
      (
        await one(
          client,
          "SELECT status FROM review_items WHERE id = 'review-key-legacy'",
        )
      ).status,
      "open",
    );

    const correct = await actOnFinanceReviewItem(
      client,
      {
        kind: "map_account_key",
        reviewItemId: "review-key-correct",
        targetAccountId: "acct-target",
        aliasKind: "statement_number",
      },
      now,
    );
    assert.equal(correct.accountAliasesCreated, 0);
    assert.equal(correct.status, "resolved");
    assert.equal(correct.reviewItemsChanged, 1);
  },
);

test(
  "explicit dismissal records that no canonical data changed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const dismissed = await actOnFinanceReviewItem(client, {
      kind: "dismiss",
      reviewItemId: "review-unparsed",
      note: "known unsupported legacy statement",
    });
    assert.equal(dismissed.status, "dismissed");
    assert.equal(dismissed.canonicalRowsChanged, 0);
    assert.match(dismissed.description, /No canonical data was changed/);
  },
);
