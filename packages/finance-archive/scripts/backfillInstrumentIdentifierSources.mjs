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
// not reconstruct it: `reparse` is scoped to the two document tiers
// (pdf_statement, trade_confirmation), and the identifiers were stated by the
// activity feed, which is an export-tier pull reparse never revisits.
//
// What counts as evidence here, and why it is this narrow
// ----------------------------------------------------------------------
// A row is evidence only if the descriptor behind it could have stated an
// identifier. Nothing records that after the fact, so this reconstructs it
// from two stored signals and refuses to guess past them.
//
//   1. `transactions.provider_txn_id IS NOT NULL`. The activity feed carries
//      the provider's own id for every row (`activityId` or
//      `transactionSequenceNumber`) and states a cusip alongside the symbol.
//      A transaction parsed off a statement page sets `externalId: null` and
//      names its instrument by symbol alone. A null provider id is therefore
//      exactly the shape that cannot have carried an identifier, and counting
//      it would rebuild the circularity this table exists to break: a weakly
//      matched statement transaction would vouch for the next weak match.
//   2. The source document is an export-tier capture, by
//      `documents.media_type`. A statement or confirmation is
//      `application/pdf`; a feed pull is JSON or CSV.
//
// `documents.doc_type` is deliberately not the discriminator, though it is the
// obvious one. It is operator-chosen free text out of the selection file, not
// a closed enum: the owner's archive labels its captures `statement` and
// `activity_pull`, while the adapter's own document-type names are
// `ClientStatements` and `TradeConfirmations`. A literal list would be a guess
// that fails silently against either spelling. `media_type` is the adapter's
// own declaration (`RetainedMediaType`, adapter.ts) and means the same thing
// for every institution.
//
// An instrument two or more institutions qualify for is skipped outright, both
// rows and all. Once two feeds reference it there is no "the institution that
// established the identifier" left to name, and the rule refuses it either
// way; writing both rows would only change which refusal it reports, and this
// pass is a reconstruction, so it claims the less.
//
// Residual ceiling. A feed row whose own cusip field was "-" is symbol-only
// too, and carries a provider id like every other feed row, so this cannot
// tell it apart. That is acceptable for what the pass actually concludes: the
// instrument carries an identifier, and only this one institution's feed
// references it, so the identifier can only have come from a feed row of that
// same institution. The attribution is right even when the particular row
// counted here is not the row that stated it. It is wrong only if the
// identifier was written by hand, or by a source that left no transaction at
// all -- which is the same case the rule refuses going forward, and the reason
// an operator who wants no reconstruction may simply not run this.
//
// Statement holdings are not uniformly identifier-free, and nothing here
// assumes they are: a bond block prints "CUSIP <nine characters>" on its
// detail line and `statementLayout.mjs`'s `resolveInstrument` reads it. Those
// descriptors produce positions, and a position is never counted here, so such
// a holding reaches the archive through the cusip tier on its own merits
// rather than through this reconstruction.
//
// Dry run by default: nothing is written without `--apply`, and both modes
// report the same counts, so an operator sees what a run would do before it
// does it. Idempotent: the insert conflicts on the table's own primary key and
// does nothing, so a second run writes nothing, and a run after real imports
// have started never disturbs what they recorded.
//
// Usage (development-first: point this at a throwaway database before a
// hosted one, same as scripts/provision.mjs):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/backfillInstrumentIdentifierSources.mjs [--apply]

import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "../dist/pgStore.js";

/** Export-tier captures: everything that is not a rendered document. See the
 * header for why this, and not `documents.doc_type`, separates a feed pull
 * from a statement. */
const EXPORT_MEDIA_TYPES = [
  "application/json",
  "text/csv; charset=utf-8",
  "text/plain; charset=utf-8",
];

/**
 * Every (instrument, institution) this pass would attribute: one qualifying
 * feed reference, and only for instruments exactly one institution qualifies
 * for. `$1` is `EXPORT_MEDIA_TYPES`.
 */
const QUALIFYING_ROWS = `
  WITH qualifying AS (
    SELECT DISTINCT t.instrument_id, a.institution_id
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      JOIN instruments i ON i.id = t.instrument_id
      JOIN documents d ON d.id = t.source_document_id
     WHERE t.instrument_id IS NOT NULL
       AND t.provider_txn_id IS NOT NULL
       AND d.media_type = ANY($1::text[])
       AND (i.cusip IS NOT NULL OR i.isin IS NOT NULL)
  ), single AS (
    SELECT instrument_id FROM qualifying
     GROUP BY instrument_id HAVING count(*) = 1
  )
  SELECT q.instrument_id, q.institution_id
    FROM qualifying q JOIN single s ON s.instrument_id = q.instrument_id
`;

/**
 * Counts what this pass would do, and writes it when `apply` is true. Returns
 * counts only -- never an instrument, a symbol, an identifier or an
 * institution.
 */
export async function backfillInstrumentIdentifierSources(
  client,
  { apply = false } = {},
) {
  return withArchiveTransaction(client, async () => {
    if (apply) await lockArchiveForWrite(client);
    const counts = await client.query(
      `WITH referenced AS (
         SELECT DISTINCT t.instrument_id, a.institution_id,
                (t.provider_txn_id IS NOT NULL
                   AND d.media_type = ANY($1::text[])) AS qualifies
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           JOIN instruments i ON i.id = t.instrument_id
           LEFT JOIN documents d ON d.id = t.source_document_id
          WHERE t.instrument_id IS NOT NULL
            AND (i.cusip IS NOT NULL OR i.isin IS NOT NULL)
       ), per_instrument AS (
         SELECT instrument_id,
                count(*) FILTER (WHERE qualifies) AS institutions
           FROM referenced GROUP BY instrument_id
       )
       SELECT count(*)::text AS considered,
              count(*) FILTER (WHERE institutions = 1)::text AS qualifying,
              count(*) FILTER (WHERE institutions > 1)::text AS several,
              count(*) FILTER (WHERE institutions = 0)::text AS no_feed
         FROM per_instrument`,
      [EXPORT_MEDIA_TYPES],
    );
    const row = counts.rows[0];
    const report = {
      applied: apply,
      considered: Number(row.considered),
      qualifying: Number(row.qualifying),
      skippedSeveralInstitutions: Number(row.several),
      skippedNoFeedEvidence: Number(row.no_feed),
      written: 0,
    };
    if (apply) {
      const inserted = await client.query(
        `INSERT INTO instrument_identifier_sources (instrument_id, institution_id)
         ${QUALIFYING_ROWS}
         ON CONFLICT (instrument_id, institution_id) DO NOTHING`,
        [EXPORT_MEDIA_TYPES],
      );
      report.written = inserted.rowCount ?? 0;
    }
    return report;
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const client = createArchiveClient(archiveDatabaseUrl(), archiveSchemaName());
  await client.connect();
  try {
    const report = await backfillInstrumentIdentifierSources(client, { apply });
    console.log(`mode: ${apply ? "apply" : "dry run (pass --apply to write)"}`);
    console.log(`instruments considered: ${report.considered}`);
    console.log(`instruments qualifying: ${report.qualifying}`);
    console.log(
      `instruments skipped (several institutions): ${report.skippedSeveralInstitutions}`,
    );
    console.log(
      `instruments skipped (no feed evidence): ${report.skippedNoFeedEvidence}`,
    );
    console.log(`source rows written: ${report.written}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
