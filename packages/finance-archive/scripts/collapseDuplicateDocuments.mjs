#!/usr/bin/env node
// F1-71. Collapses `documents` rows that are repeat captures of one provider
// document into a single canonical row.
//
// The defect this cleans up after: Morgan Stanley renders a fresh PDF on
// every download, so the same statement hashes differently every time it is
// pulled, and `documents.sha256` -- the importer's whole-document dedupe key
// -- never matched. Every pull round re-recorded all 1,321 statements as new
// documents: 6,461 rows on the owner's archive for about 1,018 distinct
// account-months. Holdings survived mostly intact (positions, balances and
// liabilities dedupe on their own `row_hash`, which does not include the
// document), but every reparse, every gate pass, every retained text and
// every review item walked all 6,461 copies.
//
// What this does NOT do: touch the raw tree. Every capture stays exactly
// where it is, and so do its bytes -- ground rule 1, raw files are immutable
// and every capture is retained. Duplicate `documents` rows are marked
// `superseded_by` rather than deleted, for the same reason: the capture they
// name is real and still on disk, and the row is the archive's own record of
// it. What changes is which row the derived tables point at.
//
// How rows are grouped, strongest identity first:
//
//   1. `documents.provider_document_id`, when it is set. This is the real
//      identity (pgSchema.ts migration 10) and the only one that is exact.
//   2. The capture manifest's `providerDocumentId` (captures.ts), for a row
//      whose column is still NULL but whose capture recorded one.
//   3. Failing both -- which on a live archive is every row captured before
//      F1-71 shipped, because nothing recorded a provider id then -- the
//      document's own metadata (institution, account, doc_type, doc_date, and
//      the capture's own period when its manifest can be read) plus the
//      normalized hash of the row's own retained text (F1-71b):
//      `documents.text_path`, read and resolved against the raw tree root,
//      whitespace runs collapsed to one space, sha256. Metadata alone
//      measured 1,018 groups against a provider listing of 1,321 statements,
//      with about 100 of those groups holding 2-4 genuinely different
//      documents (same account, same statement date, same ~28-day period --
//      adding the period changed nothing). Text does what period could not:
//      a provider re-render produces different PDF bytes but identical
//      parsed text, while two different documents never share text, so the
//      hash can only fail to merge a group (leaving a duplicate row
//      standing), never merge two different documents. A row with no
//      `text_path`, or whose text file is missing or unreadable, gets a key
//      unique to that row instead -- it is never merged with anything, and
//      the run counts and prints how many rows fell back this way. The run
//      prints how many groups were formed each way, so an operator sees how
//      much of a collapse rested on the proxy rather than on a real id.
//
// Which row survives: the earliest capture (`capturedAt` on the capture
// manifest), because that is the row whose bytes the already-imported rows
// were actually parsed from. A row whose capture cannot be read orders last;
// ties break on id, which is stable if not chronological.
//
// Idempotent: a second run finds no group with more than one non-superseded
// row and changes nothing.
//
// Usage (development-first: point this at a throwaway database before a
// hosted one, same as every other script here):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//   FINANCE_ARCHIVE_RAW_TREE_ROOT=<managed root> \
//   FINANCE_ARCHIVE_SPACE_ID=<space> \
//     node scripts/collapseDuplicateDocuments.mjs [--dry-run] [--no-gates]
//
// The raw-tree variables are optional: without them no capture manifest is
// read, so grouping falls back to metadata alone and canonical rows are
// picked by id. The script says so rather than pretending it read them.

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";

import { readCaptureManifestById } from "../dist/captures.js";
import { runPositionReconciliationGate } from "../dist/positionReconciliation.js";
import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "../dist/pgStore.js";
import { resolveRawTreeRoot, sha256HexOf } from "../dist/rawTree.js";
import { runReconciliationGate } from "../dist/reconciliation.js";

/**
 * Every table and column that points at `documents(id)`, and what makes two
 * of its rows "the same row" once they land under one document.
 *
 * `collisionKey` is the identity a unique constraint already enforces on that
 * table, so repointing can never create a row the table would have refused:
 * `row_hash` for the four content-hashed tables, and
 * `review_items_dedupe_key`'s own columns for review items. A row that would
 * collide is deleted instead of repointed (the canonical document's own copy
 * of it is kept, always). `null` means the table has no such constraint and
 * every row simply repoints.
 *
 * `collapseDuplicateDocuments` cross-checks this list against the database's
 * own foreign keys and refuses to run if the schema has a reference this list
 * does not know about -- a later migration adding one must decide what
 * "the same row" means for it rather than have rows silently orphaned.
 */
const HASH_KEY = { parts: ["r.row_hash"], required: ["r.row_hash"] };
const DOCUMENT_REFERENCES = [
  { table: "transactions", column: "source_document_id", collisionKey: HASH_KEY },
  { table: "positions", column: "source_document_id", collisionKey: HASH_KEY },
  { table: "balances", column: "source_document_id", collisionKey: HASH_KEY },
  { table: "liabilities", column: "source_document_id", collisionKey: HASH_KEY },
  { table: "commitments", column: "source_document_id", collisionKey: null },
  {
    table: "review_items",
    column: "source_document_id",
    collisionKey: {
      parts: ["r.kind", "COALESCE(r.source_locator, '')", "r.raw_value"],
      required: ["r.raw_value"],
    },
  },
  // F1-58's "most recent sighting" pointer. No constraint of its own: it is
  // one column on a row whose identity lives in the entry above.
  { table: "review_items", column: "last_seen_document_id", collisionKey: null },
];

/**
 * Immutable holding history binds one retained document revision. Moving it
 * to another capture would rewrite provenance; leaving it on a row this
 * script supersedes would make the active/history graph disagree about which
 * document owns the assertion. These references are known but deliberately
 * never repointed. A selected group touching either one is refused below.
 */
const PROTECTED_DOCUMENT_REFERENCES = [
  { table: "holding_projection_generations", column: "document_id" },
  { table: "holding_projection_assertions", column: "source_document_id" },
  { table: "position_scope_observations", column: "source_document_id" },
];

/** `documents.superseded_by` is this script's own output, not something it
 * repoints. */
const SELF_REFERENCE = { table: "documents", column: "superseded_by" };

async function assertReferencesKnown(client) {
  const { rows } = await client.query(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.constraint_schema = current_schema()
        AND ccu.table_name = 'documents'
        AND ccu.column_name = 'id'`,
  );
  const known = new Set(
    [...DOCUMENT_REFERENCES, ...PROTECTED_DOCUMENT_REFERENCES, SELF_REFERENCE].map(
      (ref) => `${ref.table}.${ref.column}`,
    ),
  );
  const unknown = rows
    .map((row) => `${row.table_name}.${row.column_name}`)
    .filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `this archive has foreign key(s) to documents(id) this script does not know how to ` +
        `repoint: ${[...new Set(unknown)].sort().join(", ")}. Add them to DOCUMENT_REFERENCES ` +
        "with the identity that makes two of their rows the same row, then re-run.",
    );
  }
}

/**
 * Resolves a `documents.text_path` value to a readable path: absolute paths
 * (what the importer has always written) are used as-is, and a relative one
 * -- never produced today, but the safer assumption for a value that
 * outlives this script -- is resolved against the raw tree root the caller
 * already resolved via `resolveRawTreeRoot`. Returns null when the path
 * cannot be resolved (relative, with no configured root).
 */
function resolveTextPath(rawTreeRoot, textPath) {
  if (isAbsolute(textPath)) return textPath;
  if (rawTreeRoot === null) return null;
  return join(rawTreeRoot, textPath);
}

/**
 * The normalized sha256 of a row's retained text -- whitespace runs
 * collapsed to one space, trimmed, hashed -- or null when there is no text
 * to hash: no `text_path`, an unresolvable relative one, or a file this
 * process cannot read. F1-71b: a provider re-render produces different PDF
 * bytes but identical parsed text, so this is a safe key on top of
 * metadata -- it can only fail to merge a group, never merge two different
 * documents.
 */
function metadataTextHash(rawTreeRoot, textPath) {
  if (!textPath) return null;
  const resolved = resolveTextPath(rawTreeRoot, textPath);
  if (resolved === null) return null;
  try {
    const text = readFileSync(resolved, "utf8");
    return sha256HexOf(Buffer.from(text.replace(/\s+/g, " ").trim(), "utf8"));
  } catch {
    return null;
  }
}

/** The identity of one `documents` row, and where that identity came from.
 * `rawTreeRoot` is null when no raw tree is configured; the metadata branch
 * still tries to hash `text_path` when it is already an absolute path. */
function identify(row, capture, rawTreeRoot) {
  const providerId = row.provider_document_id ?? capture?.manifest.providerDocumentId ?? null;
  if (providerId !== null) {
    return {
      key: ["pid", row.institution_id ?? "", providerId].join("\0"),
      source: row.provider_document_id === null ? "capture_manifest" : "provider_column",
      providerDocumentId: providerId,
      textFallback: false,
    };
  }
  const textHash = metadataTextHash(rawTreeRoot, row.text_path);
  if (textHash === null) {
    // No usable retained text: a key unique to this row (its own id), so it
    // is never merged with anything. Counted, not silently degraded.
    return {
      key: ["row", row.id].join("\0"),
      source: "metadata_no_text",
      providerDocumentId: null,
      textFallback: true,
    };
  }
  return {
    key: [
      "meta",
      row.institution_id ?? "",
      row.doc_type,
      row.account_id ?? "",
      row.doc_date ?? "",
      capture?.manifest.periodStart ?? "",
      capture?.manifest.periodEnd ?? "",
      textHash,
    ].join("\0"),
    source: "metadata",
    providerDocumentId: null,
    textFallback: false,
  };
}

/** Thrown to roll a dry run back. A dry run does the real work and then
 * refuses to commit it, so the counts it reports are what actually happened
 * rather than a second implementation's estimate of it. */
class DryRun extends Error {
  constructor(report) {
    super("dry run");
    this.report = report;
  }
}

/**
 * Collapses every duplicate group against an already-connected archive
 * client. `rawTreeRoot` may be null, in which case no capture manifest is
 * read. Exported so the test suite can drive it against a throwaway schema
 * instead of shelling out to this file.
 */
export async function collapseDuplicateDocuments(
  client,
  { dryRun = false, rawTreeRoot = null } = {},
) {
  const run = async (tx) => {
    await lockArchiveForWrite(tx);
    await assertReferencesKnown(tx);

    const { rows } = await tx.query(
      `SELECT id, institution_id, account_id, doc_type, doc_date::text AS doc_date,
              provider_document_id, capture_id, text_path
         FROM documents
        WHERE superseded_by IS NULL
        ORDER BY id`,
    );

    const report = {
      documentsConsidered: rows.length,
      groups: 0,
      groupsBySource: { provider_column: 0, capture_manifest: 0, metadata: 0 },
      rowsWithoutUsableText: 0,
      superseded: 0,
      canonicalRemaining: 0,
      providerIdsRecovered: 0,
      capturesRead: 0,
      capturesUnreadable: 0,
      repointed: {},
      deleted: {},
    };

    const groups = new Map();
    for (const row of rows) {
      let capture = null;
      if (rawTreeRoot !== null && row.capture_id !== null) {
        try {
          capture = readCaptureManifestById(rawTreeRoot, row.capture_id);
          report.capturesRead += 1;
        } catch {
          // A capture this script cannot read is not a reason to refuse the
          // whole collapse: it costs this row its capture time and its
          // recorded period, both of which the fallbacks below cover. The
          // count is reported so an unreadable raw tree is visible rather
          // than silently degrading every group's identity.
          report.capturesUnreadable += 1;
        }
      }
      const identity = identify(row, capture, rawTreeRoot);
      if (identity.textFallback) report.rowsWithoutUsableText += 1;
      const group = groups.get(identity.key) ?? {
        source: identity.source,
        providerDocumentId: identity.providerDocumentId,
        members: [],
      };
      // The strongest source any member had: a group two rows join by
      // metadata, one of which does carry a real provider id, is a group that
      // was formed on that id as far as an operator reading the counts is
      // concerned.
      if (group.providerDocumentId === null && identity.providerDocumentId !== null) {
        group.providerDocumentId = identity.providerDocumentId;
        group.source = identity.source;
      }
      group.members.push({
        id: row.id,
        capturedAt: capture?.manifest.capturedAt ?? null,
        providerDocumentId: row.provider_document_id,
      });
      groups.set(identity.key, group);
    }

    const pairs = [];
    const recoverProviderId = [];
    for (const group of groups.values()) {
      if (group.members.length < 2) continue;
      report.groups += 1;
      report.groupsBySource[group.source] += 1;
      // Earliest capture first; a member with no readable capture orders
      // last; id breaks every remaining tie.
      const ordered = [...group.members].sort((a, b) => {
        if (a.capturedAt !== b.capturedAt) {
          if (a.capturedAt === null) return 1;
          if (b.capturedAt === null) return -1;
          return a.capturedAt < b.capturedAt ? -1 : 1;
        }
        return a.id < b.id ? -1 : 1;
      });
      const [canonical, ...duplicates] = ordered;
      for (const duplicate of duplicates) {
        pairs.push([duplicate.id, canonical.id]);
      }
      if (group.providerDocumentId !== null && canonical.providerDocumentId === null) {
        recoverProviderId.push([canonical.id, group.providerDocumentId]);
      }
    }
    report.superseded = pairs.length;
    report.canonicalRemaining = report.documentsConsidered - report.superseded;

    if (pairs.length === 0) {
      if (dryRun) throw new DryRun(report);
      return report;
    }

    // One temp table and a handful of set-based statements, rather than a
    // few queries per duplicate: the archive is hosted, so the cost of this
    // is messages, and 5,000 duplicates times seven references is not a
    // shape to pay a round trip for.
    await tx.query(
      `CREATE TEMP TABLE collapse_map (
         duplicate_id TEXT PRIMARY KEY,
         canonical_id TEXT NOT NULL
       ) ON COMMIT DROP`,
    );
    await tx.query(
      `INSERT INTO collapse_map (duplicate_id, canonical_id)
       SELECT * FROM unnest($1::text[], $2::text[])`,
      [pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])],
    );

    const protectedReference = await tx.query(
      `SELECT EXISTS (
         SELECT 1 FROM holding_projection_generations h
          WHERE h.document_id IN (
            SELECT duplicate_id FROM collapse_map
            UNION SELECT canonical_id FROM collapse_map)
         UNION ALL
         SELECT 1 FROM holding_projection_assertions h
          WHERE h.source_document_id IN (
            SELECT duplicate_id FROM collapse_map
            UNION SELECT canonical_id FROM collapse_map)
         UNION ALL
         SELECT 1 FROM position_scope_observations h
          WHERE h.source_document_id IN (
            SELECT duplicate_id FROM collapse_map
            UNION SELECT canonical_id FROM collapse_map)
       ) AS present`,
    );
    if (protectedReference.rows[0]?.present === true) {
      throw new Error(
        "cannot collapse a selected document group that owns immutable holding projection history or position scope history",
      );
    }

    for (const reference of DOCUMENT_REFERENCES) {
      const { table, column, collisionKey } = reference;
      const name = `${table}.${column}`;
      if (collisionKey !== null) {
        // Everything that will live under one canonical document once this
        // repoints -- the rows already there and the rows arriving -- ranked
        // so the canonical document's own row always wins. Anything after the
        // first of an identity is a row the table's own unique constraint
        // would refuse, so it is deleted rather than repointed. A NULL
        // component is never a collision, exactly as a unique constraint
        // treats it.
        const aliases = collisionKey.parts.map((_, index) => `k${index}`);
        const selected = collisionKey.parts
          .map((part, index) => `${part} AS ${aliases[index]}`)
          .join(", ");
        const required = collisionKey.required
          .map((part) => `${part} IS NOT NULL`)
          .join(" AND ");
        const deleted = await tx.query(
          `WITH scope AS (
             SELECT r.id,
                    COALESCE(m.canonical_id, r.${column}) AS target,
                    (m.duplicate_id IS NULL) AS is_canonical,
                    ${selected}
               FROM ${table} r
               LEFT JOIN collapse_map m ON m.duplicate_id = r.${column}
              WHERE (r.${column} IN (SELECT duplicate_id FROM collapse_map)
                  OR r.${column} IN (SELECT canonical_id FROM collapse_map))
                AND ${required}
           ),
           ranked AS (
             SELECT id, is_canonical,
                    row_number() OVER (
                      PARTITION BY target, ${aliases.join(", ")}
                      ORDER BY is_canonical DESC, id
                    ) AS rn
               FROM scope
           )
           DELETE FROM ${table}
            WHERE id IN (SELECT id FROM ranked WHERE rn > 1 AND NOT is_canonical)`,
        );
        report.deleted[name] = deleted.rowCount ?? 0;
      }
      const repointed = await tx.query(
        `UPDATE ${table} r SET ${column} = m.canonical_id
           FROM collapse_map m
          WHERE r.${column} = m.duplicate_id`,
      );
      report.repointed[name] = repointed.rowCount ?? 0;
    }

    if (recoverProviderId.length > 0) {
      const recovered = await tx.query(
        `UPDATE documents d SET provider_document_id = v.provider_document_id
           FROM (SELECT * FROM unnest($1::text[], $2::text[])
                   AS t(id, provider_document_id)) v
          WHERE d.id = v.id AND d.provider_document_id IS NULL`,
        [
          recoverProviderId.map((pair) => pair[0]),
          recoverProviderId.map((pair) => pair[1]),
        ],
      );
      report.providerIdsRecovered = recovered.rowCount ?? 0;
    }

    // Last, so every reference has already moved off these rows: a row marked
    // superseded must never still be the document something cites.
    await tx.query(
      `UPDATE documents d SET superseded_by = m.canonical_id
         FROM collapse_map m
        WHERE d.id = m.duplicate_id`,
    );

    if (dryRun) throw new DryRun(report);
    return report;
  };

  try {
    return await withArchiveTransaction(client, run);
  } catch (error) {
    if (error instanceof DryRun) return error.report;
    throw error;
  }
}

function printReport(report, dryRun) {
  console.log(`mode: collapseDuplicateDocuments${dryRun ? " (dry run)" : ""}`);
  console.log(`documents considered: ${report.documentsConsidered}`);
  console.log(`capture manifests read: ${report.capturesRead} (unreadable: ${report.capturesUnreadable})`);
  console.log(`duplicate groups: ${report.groups}`);
  console.log(
    `  grouped by provider document id: ${report.groupsBySource.provider_column} ` +
      `(from a capture manifest: ${report.groupsBySource.capture_manifest})`,
  );
  console.log(`  grouped by document metadata and retained text: ${report.groupsBySource.metadata}`);
  console.log(
    `  rows with no usable retained text (kept their own key, never merged): ` +
      `${report.rowsWithoutUsableText}`,
  );
  console.log(
    `documents ${dryRun ? "that would be marked" : "marked"} superseded: ${report.superseded}`,
  );
  console.log(
    `canonical documents ${dryRun ? "that would remain" : "remaining"}: ${report.canonicalRemaining}`,
  );
  console.log(`provider document ids recovered onto canonical rows: ${report.providerIdsRecovered}`);
  for (const [name, rowCount] of Object.entries(report.repointed).sort()) {
    console.log(`  ${name}: repointed=${rowCount} deleted=${report.deleted[name] ?? 0}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      "no-gates": { type: "boolean", default: false },
    },
  });
  const dryRun = values["dry-run"] === true;

  // Optional: without a configured raw tree this still collapses, just
  // without capture times or manifest-recorded provider ids. Saying which
  // happened matters more than failing.
  let rawTreeRoot = null;
  try {
    rawTreeRoot = resolveRawTreeRoot();
  } catch (error) {
    console.log(`no raw tree configured (${error.message.split(".")[0]}); grouping on the database alone`);
  }

  const client = createArchiveClient(archiveDatabaseUrl(), archiveSchemaName());
  await client.connect();
  try {
    const report = await collapseDuplicateDocuments(client, { dryRun, rawTreeRoot });
    printReport(report, dryRun);
    if (report.groups === 0) {
      console.log("nothing to collapse");
      return;
    }
    if (dryRun) {
      console.log("re-run without --dry-run to apply this, then re-run the whole-archive gates");
      return;
    }
    if (values["no-gates"] === true) {
      console.log("gates skipped (--no-gates); run them before trusting this archive's verdicts");
      return;
    }
    // A whole-archive pass, because this moved which document every derived
    // row cites. Nothing a gate reads changed -- verdicts are computed from
    // accounts, dates and amounts -- so the point is to prove that, on this
    // archive, rather than to assert it.
    const cash = await runReconciliationGate(client);
    const positions = await runPositionReconciliationGate(client);
    console.log(
      `whole-archive cash gate: passed=${cash.passed} failed=${cash.failed} unverified=${cash.unverified}`,
    );
    console.log(
      `whole-archive position gate: passed=${positions.passed} failed=${positions.failed} ` +
        `unverified=${positions.unverified}`,
    );
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
