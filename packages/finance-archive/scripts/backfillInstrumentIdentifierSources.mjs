#!/usr/bin/env node
// Backfills instrument_identifier_sources (F1-76 phase 3, pgSchema.ts
// migration version 13) for instruments minted before the table existed.
//
// The table records which institutions' parsed descriptors actually stated a
// cusip or an isin for an instrument, and it is the only evidence the
// same-institution symbol rule accepts. The importer writes it going forward
// (adapterImport.ts's `flushInstruments`), but a live archive's instruments
// were all minted before it, so without this pass every symbol-only match is
// refused as `instrument_has_no_institution_evidence` forever. A reparse does
// not reconstruct it on its own: `reparse` is scoped to the two document tiers
// (pdf_statement, trade_confirmation), and the identifiers were stated by the
// activity feed, which is an export-tier pull reparse never revisits.
//
// Transactions only, never positions. This is the whole point of the pass and
// the reason it is a script rather than a line in the migration:
//
//   - A statement holding names an instrument by symbol and name and carries
//     no identifier at all (verified over 1,237 statements). A `positions` row
//     is therefore never evidence that anyone stated an identifier, and
//     counting one is circular -- a match this rule refused still writes its
//     position, and that position would then vouch for the next match.
//   - The activity feed states a symbol and a cusip, and it is what produces
//     `transactions`. So a transaction from institution X referencing an
//     instrument that carries a cusip or isin is the archive's best surviving
//     record that X's own data named it.
//
// That is a reconstruction, not a recording, and it is conservative in one
// direction only: an activity row matched by symbol alone would also be
// counted here, so an operator who wants no reconstructed evidence at all can
// skip this script entirely and let the rule refuse every pre-existing
// instrument. Every source row written after this pass is recorded at the
// moment the descriptor states the identifier, with no inference.
//
// Idempotent: the insert conflicts on the table's own primary key and does
// nothing, so a second run writes nothing and a run after real imports have
// started never disturbs what they recorded.
//
// Usage (development-first: point this at a throwaway database before a
// hosted one, same as scripts/provision.mjs):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/backfillInstrumentIdentifierSources.mjs

import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "../dist/pgStore.js";

/**
 * Writes one row per (instrument, institution) where that institution has a
 * transaction referencing an instrument that carries a cusip or an isin, and
 * returns counts only -- never an instrument, a symbol or an identifier.
 */
export async function backfillInstrumentIdentifierSources(client) {
  return withArchiveTransaction(client, async () => {
    await lockArchiveForWrite(client);
    const inserted = await client.query(
      `INSERT INTO instrument_identifier_sources (instrument_id, institution_id)
       SELECT DISTINCT t.instrument_id, a.institution_id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN instruments i ON i.id = t.instrument_id
        WHERE t.instrument_id IS NOT NULL
          AND (i.cusip IS NOT NULL OR i.isin IS NOT NULL)
       ON CONFLICT (instrument_id, institution_id) DO NOTHING`,
    );
    const totals = await client.query(
      `SELECT count(*)::text AS sources,
              count(DISTINCT instrument_id)::text AS instruments
         FROM instrument_identifier_sources`,
    );
    return {
      inserted: inserted.rowCount ?? 0,
      sources: Number(totals.rows[0].sources),
      instruments: Number(totals.rows[0].instruments),
    };
  });
}

async function main() {
  const client = createArchiveClient(archiveDatabaseUrl(), archiveSchemaName());
  await client.connect();
  try {
    const report = await backfillInstrumentIdentifierSources(client);
    console.log(`source rows written: ${report.inserted}`);
    console.log(`source rows on file: ${report.sources}`);
    console.log(`instruments with a recorded source: ${report.instruments}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
