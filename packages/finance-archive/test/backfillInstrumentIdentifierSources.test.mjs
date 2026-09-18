// F1-76 phase 3. scripts/backfillInstrumentIdentifierSources.mjs against a
// real, throwaway archive.
//
// The whole point of this pass is what it refuses to count. A transaction
// parsed off a statement page names its instrument by symbol alone and carries
// no provider id, so counting one would rebuild the circularity
// `instrument_identifier_sources` exists to break: a weakly matched statement
// transaction would become the evidence that vouches for the next weak match.
// Synthetic institutions, synthetic tickers, synthetic identifiers throughout.

import assert from "node:assert/strict";
import test from "node:test";

import { backfillInstrumentIdentifierSources } from "../scripts/backfillInstrumentIdentifierSources.mjs";

import { all, archive, count, skip } from "./helpers/pgArchive.mjs";

const FEED = { id: "inst_feed", slug: "feed-trust" };
const OTHER = { id: "inst_other", slug: "other-trust" };

async function seed(client) {
  for (const institution of [FEED, OTHER]) {
    await client.query(
      "INSERT INTO institutions (id, name, slug) VALUES ($1, 'Synthetic', $2)",
      [institution.id, institution.slug],
    );
    await client.query(
      `INSERT INTO accounts (id, institution_id, acct_last4, base_currency)
       VALUES ($1, $2, '0199', 'USD')`,
      [`acct_${institution.id}`, institution.id],
    );
  }
}

/** One document, either an export-tier feed pull or a rendered statement. */
async function document(client, id, institutionId, kind) {
  // All four retained-provenance columns or none (documents' own CHECK), so
  // `media_type` -- the column this pass actually reads -- comes with the rest.
  const sha = id.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "1");
  await client.query(
    `INSERT INTO documents
       (id, institution_id, doc_type, file_path, sha256,
        retained_sha256, retained_byte_length, media_type, capture_id)
     VALUES ($1, $2, $3, $4, $5, $5, 1, $6, $7)`,
    [
      id,
      institutionId,
      kind === "feed" ? "activity_pull" : "statement",
      `/raw/${id}`,
      sha,
      kind === "feed" ? "application/json" : "application/pdf",
      `capture-${id}`,
    ],
  );
}

async function instrument(client, id, cusip) {
  await client.query(
    "INSERT INTO instruments (id, symbol, cusip) VALUES ($1, 'ZZZ', $2)",
    [id, cusip],
  );
}

/** `providerTxnId` null is the statement-page shape: no provider id, and an
 * instrument named by symbol alone. */
async function transaction(client, id, institutionId, documentId, instrumentId, providerTxnId) {
  await client.query(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, instrument_id, currency,
        source_document_id, row_hash, provider_txn_id, imported_at)
     VALUES ($1, $2, DATE '2026-03-31', 'buy', $3, 'USD', $4, $5, $6, now())`,
    [id, `acct_${institutionId}`, instrumentId, documentId, `hash-${id}`, providerTxnId],
  );
}

const sources = (client) =>
  all(
    client,
    "SELECT instrument_id, institution_id FROM instrument_identifier_sources ORDER BY instrument_id",
  );

test(
  "the identifier-source backfill counts a feed reference, never a statement one, and is dry by default",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await document(client, "doc_feed", FEED.id, "feed");
    await document(client, "doc_statement", FEED.id, "statement");

    // Referenced by this institution's activity feed: the shape that states a
    // cusip alongside the symbol.
    await instrument(client, "instr_feed", "111111ZZ1");
    await transaction(client, "txn_feed", FEED.id, "doc_feed", "instr_feed", "provider-1");

    // Referenced only by statement-page activity: symbol-only by construction,
    // no provider id. Counting it is the circularity this pass exists to
    // avoid.
    await instrument(client, "instr_statement", "222222ZZ2");
    await transaction(
      client,
      "txn_statement",
      FEED.id,
      "doc_statement",
      "instr_statement",
      null,
    );

    const dry = await backfillInstrumentIdentifierSources(client);
    assert.equal(dry.applied, false);
    assert.equal(dry.considered, 2);
    assert.equal(dry.qualifying, 1);
    assert.equal(dry.skippedNoFeedEvidence, 1);
    assert.equal(dry.written, 0);
    assert.equal(
      await count(client, "instrument_identifier_sources"),
      0,
      "a dry run writes nothing",
    );

    const applied = await backfillInstrumentIdentifierSources(client, {
      apply: true,
    });
    assert.equal(applied.qualifying, 1);
    assert.equal(applied.written, 1);
    assert.deepEqual(await sources(client), [
      { instrument_id: "instr_feed", institution_id: FEED.id },
    ]);

    // Idempotent: a second run reports the same counts and writes nothing.
    const again = await backfillInstrumentIdentifierSources(client, {
      apply: true,
    });
    assert.equal(again.qualifying, 1);
    assert.equal(again.written, 0);
    assert.deepEqual(await sources(client), [
      { instrument_id: "instr_feed", institution_id: FEED.id },
    ]);
  },
);

test(
  "an instrument two institutions' feeds reference is skipped entirely, rather than attributed to one of them",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await document(client, "doc_feed_a", FEED.id, "feed");
    await document(client, "doc_feed_b", OTHER.id, "feed");
    await instrument(client, "instr_shared", "111111ZZ1");
    await transaction(client, "txn_a", FEED.id, "doc_feed_a", "instr_shared", "provider-1");
    await transaction(client, "txn_b", OTHER.id, "doc_feed_b", "instr_shared", "provider-2");

    const report = await backfillInstrumentIdentifierSources(client, {
      apply: true,
    });
    assert.equal(report.considered, 1);
    assert.equal(report.qualifying, 0);
    assert.equal(report.skippedSeveralInstitutions, 1);
    assert.equal(report.written, 0);
    assert.equal(await count(client, "instrument_identifier_sources"), 0);
  },
);

test(
  "an instrument with no identifier on file is never attributed, however it is referenced",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await document(client, "doc_feed", FEED.id, "feed");
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('instr_bare', 'ZZZ')",
    );
    await transaction(client, "txn_bare", FEED.id, "doc_feed", "instr_bare", "provider-1");

    const report = await backfillInstrumentIdentifierSources(client, {
      apply: true,
    });
    assert.equal(report.considered, 0);
    assert.equal(report.written, 0);
    assert.equal(await count(client, "instrument_identifier_sources"), 0);
  },
);
