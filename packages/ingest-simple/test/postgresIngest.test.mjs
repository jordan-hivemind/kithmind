// One end-to-end proof against a real, throwaway local Postgres (started and
// stopped by this test, nothing left running): ingest a synthetic two-page
// PDF, read it back through `documents.getDocument` and confirm two pages
// with page-cited text, then run again and confirm the second run inserts
// nothing (the `archive_ref` skip check holds).

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyKithSchema, createKithPool, documents, newKithId, sha256 } from "@repo/kith-store";
import { runIngest } from "../dist/ingest.js";
import { ingestFile } from "../dist/write.js";

import { acquirePostgres, skip } from "./helpers/pgServer.mjs";
import { buildPdf } from "./helpers/pdf.mjs";

/** Boots a throwaway Postgres with the kith schema applied and one seeded
 * user/space/fs-source-account, shared by every test below. */
async function bootstrapDatabase(t) {
  const server = await acquirePostgres();
  const pool = createKithPool(server.url, 4);
  // Registered as one hook, in this order, so the pool's connections close
  // cleanly before the server they're connected to is killed -- Postgres
  // sends "terminating connection due to administrator command" to any
  // client still attached when `pg_ctl stop` runs, which `pg` surfaces as an
  // uncaught connection error rather than a clean close.
  t.after(async () => {
    await pool.end();
    await server.stop();
  });

  const bootstrap = await pool.connect();
  try {
    await applyKithSchema(bootstrap);
  } finally {
    bootstrap.release();
  }

  const spaceId = newKithId();
  const userId = newKithId();
  const accountId = newKithId();
  await pool.query(`INSERT INTO kith.users (id, created_at, email, name) VALUES ($1, transaction_timestamp(), $2, $3)`, [
    userId,
    "owner@example.test",
    "Synthetic Owner",
  ]);
  await pool.query(
    `INSERT INTO kith.spaces (id, created_at, kind, name, created_by) VALUES ($1, transaction_timestamp(), 'shared', 'Synthetic Space', $2)`,
    [spaceId, userId],
  );
  await pool.query(
    `INSERT INTO kith.space_members (id, space_id, created_at, user_id, role) VALUES ($1, $2, transaction_timestamp(), $3, 'owner')`,
    [newKithId(), spaceId, userId],
  );
  await pool.query(
    `INSERT INTO kith.source_accounts
       (id, space_id, created_at, connector, account_id, name, enabled, created_by)
     VALUES ($1, $2, transaction_timestamp(), 'fs', 'synthetic-local', 'Synthetic Folder', true, $3)`,
    [accountId, spaceId, userId],
  );

  return { pool, spaceId, userId, accountId };
}

test("ingests a synthetic two-page PDF and is idempotent on a second run", { skip }, async (t) => {
  const { pool, spaceId, accountId } = await bootstrapDatabase(t);

  const root = await mkdtemp(join(tmpdir(), "ingest-simple-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdf = buildPdf([
    "Statement page one.\nAccount ending 1234.",
    "Statement page two.\nClosing balance $500.00.",
  ]);
  await writeFile(join(root, "statement.pdf"), pdf);

  const options = { root, sourceAccountId: accountId, dryRun: false, concurrency: 1 };
  const log = () => {};

  const first = await runIngest(pool, options, log);
  assert.equal(first.failed, 0, `expected no failures: ${JSON.stringify(first.failures)}`);
  assert.equal(first.newCount, 1);
  assert.equal(first.skippedUnchanged, 0);

  const item = await pool.query(
    `SELECT id, active_generation_id FROM kith.source_items WHERE source_account_id = $1`,
    [accountId],
  );
  assert.equal(item.rows.length, 1);
  assert.ok(item.rows[0].active_generation_id, "source item has no active generation after ingest");

  const documentRow = await pool.query(
    `SELECT id FROM kith.documents WHERE processing_generation_id = $1`,
    [item.rows[0].active_generation_id],
  );
  assert.equal(documentRow.rows.length, 1);
  const documentId = documentRow.rows[0].id;

  const readClient = await pool.connect();
  let document;
  try {
    document = await documents.getDocument(readClient, [spaceId], documentId);
  } finally {
    readClient.release();
  }
  assert.ok(document, "getDocument returned null for a just-activated document");
  assert.equal(document.pages.length, 2);
  assert.match(document.pages[0].text, /page one/i);
  assert.match(document.pages[1].text, /page two/i);
  assert.ok(document.pages[0].evidence.length > 0, "page one has no evidence spans");
  assert.match(document.pages[0].evidence[0].quote, /page one|account ending/i);
  assert.ok(document.pages[1].evidence.length > 0, "page two has no evidence spans");
  assert.match(document.pages[1].evidence[0].quote, /page two|closing balance/i);

  const countsBefore = await pool.query(
    `SELECT (SELECT count(*) FROM kith.documents)::int AS documents,
            (SELECT count(*) FROM kith.chunks)::int AS chunks,
            (SELECT count(*) FROM kith.source_revisions)::int AS revisions,
            (SELECT count(*) FROM kith.processing_generations)::int AS generations`,
  );

  const second = await runIngest(pool, options, log);
  assert.equal(second.failed, 0, `expected no failures on the second run: ${JSON.stringify(second.failures)}`);
  assert.equal(second.newCount, 0);
  assert.equal(second.skippedUnchanged, 1);

  const countsAfter = await pool.query(
    `SELECT (SELECT count(*) FROM kith.documents)::int AS documents,
            (SELECT count(*) FROM kith.chunks)::int AS chunks,
            (SELECT count(*) FROM kith.source_revisions)::int AS revisions,
            (SELECT count(*) FROM kith.processing_generations)::int AS generations`,
  );
  assert.deepEqual(countsAfter.rows[0], countsBefore.rows[0], "second run inserted rows for an unchanged file");
});

test("ingests a synthetic 40-page text document, over the old 32-page cap", { skip }, async (t) => {
  const { pool, spaceId, userId, accountId } = await bootstrapDatabase(t);

  // A plain text document, not a PDF: exercises the write path's own page
  // handling directly (`write.ts`'s `ingestFile`), independent of poppler or
  // the one-page-per-text-file rule `convert.ts` applies to a real `.txt`
  // file. 40 pages is over the pre-change `MAX_SOURCE_PAGES` (32) and, at
  // more than `MAX_STAGING_ROWS` (25), forces `stagePages` to batch.
  const pageCount = 40;
  const pages = Array.from(
    { length: pageCount },
    (_, index) => `Page ${index + 1} of a long synthetic household document. Line two of page ${index + 1}.`,
  );
  const fileByteHash = sha256(`synthetic-40-page-document:${pageCount}`);

  const result = await ingestFile(pool, {
    spaceId,
    sourceAccountId: accountId,
    externalId: "long-synthetic-document.txt",
    title: "Long synthetic document",
    docType: "text",
    capturedAt: new Date(),
    userId,
    fileByteHash,
    pages,
    converterFingerprint: "test-40-page-text-v1",
    mediaType: "text/plain",
  });
  assert.equal(result.pageCount, pageCount);

  const readClient = await pool.connect();
  let document;
  try {
    document = await documents.getDocument(readClient, [spaceId], result.documentId);
  } finally {
    readClient.release();
  }
  assert.ok(document, "getDocument returned null for the 40-page document");
  assert.equal(document.pages.length, pageCount, "getDocument did not return all 40 pages");
  assert.match(document.pages[0].text, /Page 1 of a long synthetic/);
  // Full-text equality on the last page, not just a substring match: proves
  // `getDocument` returns a page's complete text untruncated (the
  // `CitationOutputBudget` in documents/model.ts only ever gates the
  // `evidence` citation array -- see the PR discussion -- never `page.text`
  // itself), for the page furthest from the start of the document.
  assert.equal(
    document.pages[pageCount - 1].text,
    pages[pageCount - 1],
    "the last page's text came back incomplete or altered",
  );
  for (const page of document.pages) {
    assert.ok(page.evidence.length > 0, `page ${page.ordinal} has no evidence spans`);
  }
});
