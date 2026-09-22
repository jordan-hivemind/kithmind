// End-to-end proofs against a real, throwaway local Postgres (started and
// stopped by this test, nothing left running): ingest a synthetic two-page
// PDF, read it back through `documents.getDocument` and confirm two pages
// with page-cited text, then run again and confirm the second run inserts
// nothing (the `archive_ref`+depth skip check holds); and the glance/full
// depth policy end to end -- a synthetic tax-support document ingests at
// glance (one page, real metadata), then `--depth full` promotes the same
// source item to a new full generation (docs/plans/2026-09-22-simplification-
// and-feeds.md's "document ingestion" line and depthPolicy.ts).

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  applyKithSchema,
  createKithPool,
  documents,
  embeddings,
  newKithId,
  sha256,
  withKithTransaction,
} from "@repo/kith-store";
import { runIngest } from "../dist/ingest.js";
import { backfillEmbeddings } from "../dist/postProcess.js";
import { ingestFile, RevisionConflictError } from "../dist/write.js";

import { acquirePostgres, skip } from "./helpers/pgServer.mjs";
import { buildPdf } from "./helpers/pdf.mjs";

/** A fake OpenAI-compatible embeddings endpoint: no network, no vendor SDK.
 * Every call returns a distinct, non-zero 1536-dimension vector (real
 * `parseEmbeddingResponse` in `@repo/kith-store`'s provider.ts refuses an
 * all-zero one) and records the request bodies it received. */
function startEmbeddingStub() {
  let calls = 0;
  const requestBodies = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requestBodies.push(Buffer.concat(chunks).toString("utf8"));
      calls += 1;
      const vector = Array.from(
        { length: embeddings.BASELINE_EMBEDDING_DIMENSIONS },
        (_, index) => ((calls * 31 + index) % 97) / 97 + 0.0001,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: vector }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1/embeddings`,
        requestBodies,
        callCount: () => calls,
        async stop() {
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

/** A synthetic, non-default embedding profile pointed at `stub.url` --
 * `loadEmbeddingConfig` requires `NODE_ENV` to be "development" or "test"
 * before it allows a plain-http localhost endpoint (provider.ts's
 * `parseEndpoint`), and requires an explicit provider id/model revision for
 * any non-default endpoint. No API key is needed: `requestEmbedding` only
 * requires one for the real OpenAI default endpoint. */
function stubEmbeddingEnv(stub) {
  return {
    NODE_ENV: "test",
    BRAIN_EMBED_ENDPOINT: stub.url,
    BRAIN_EMBED_PROVIDER_ID: "test-stub",
    BRAIN_EMBED_MODEL: "test-embedding-model",
    BRAIN_EMBED_MODEL_REVISION: "test-v1",
  };
}

/** Bootstraps and activates a space's first embedding generation against an
 * empty catalog, exactly the whole-space manifest transition
 * `embeddings/generations.ts` documents ("what lets an empty-space capture
 * bootstrap ... leave behind a counted space without a separate backfill
 * run"). Real production reaches this through an operator's own bootstrap
 * (`kith-reembed`-adjacent tooling); this test reaches it directly because
 * `ingest-simple` intentionally never does this itself -- see write.ts's
 * `touchWorkerPublicationEmbedding` call, which requires an active
 * generation/profile to already exist. Returns the profile's fingerprint,
 * which must equal `kith.space_embedding_states.active_fingerprint`
 * afterward for a later fill against the same env to be accepted. */
async function activateEmptyEmbeddingGeneration(pool, spaceId, env) {
  const config = embeddings.loadEmbeddingConfig(env);
  const profile = embeddings.embeddingProfile(config);
  const fingerprint = await embeddings.fingerprintEmbeddingConfig(profile);

  const generation = await withKithTransaction(pool, (client) =>
    embeddings.createEmbeddingGeneration(
      { client, now: Date.now() },
      { spaceId, profile, fingerprint },
    ),
  );
  await withKithTransaction(pool, (client) =>
    embeddings.stageEmbeddingGeneration(
      { client, now: Date.now() },
      { embeddingGenerationId: generation.id },
    ),
  );
  await withKithTransaction(pool, (client) =>
    embeddings.activateEmbeddingGeneration(
      { client, now: Date.now() },
      { embeddingGenerationId: generation.id },
    ),
  );
  return { fingerprint };
}

/** Sets `process.env` entries for the test body and restores the prior
 * values (or absence) afterward via `t.after` -- `ingest.ts`'s
 * `runPostProcessing` call reads `process.env` directly (see ingest.ts), not
 * an injectable environment, so this is the only way a test can steer it. */
function withProcessEnv(t, overrides) {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

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

  // Forces full depth explicitly: this test is about paging/evidence
  // mechanics, not the depth policy (covered separately below), and
  // "statement.pdf" would otherwise default to `glance` under the new
  // policy (kind "statement" is not `tax_return`/`k1`).
  const options = {
    root,
    sourceAccountId: accountId,
    dryRun: false,
    concurrency: 1,
    depth: "full",
    fullMatchPatterns: [],
  };
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

test("a synthetic tax-support document ingests at glance, then --depth full promotes it to a new full generation", { skip }, async (t) => {
  const { pool, spaceId, accountId } = await bootstrapDatabase(t);

  const root = await mkdtemp(join(tmpdir(), "ingest-simple-depth-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdf = buildPdf([
    "Form W-2 Wage and Tax Statement for 2022.\nBox 1 Wages $50,000.00.",
    "Employer copy continuation page with additional boilerplate text.",
  ]);
  const fileName = "2022 W-2.pdf";
  await writeFile(join(root, fileName), pdf);

  const log = () => {};
  const autoOptions = {
    root,
    sourceAccountId: accountId,
    dryRun: false,
    concurrency: 1,
    depth: "auto",
    fullMatchPatterns: [],
  };

  // First run, default policy: "Form W-2" classifies as tax_support, which
  // is not tax_return/k1, so it ingests at glance depth -- one page only.
  const first = await runIngest(pool, autoOptions, log);
  assert.equal(first.failed, 0, `expected no failures: ${JSON.stringify(first.failures)}`);
  assert.equal(first.newCount, 1);
  assert.equal(first.promoted, 0);
  assert.equal(first.byKind.get("tax_support"), 1);
  assert.equal(first.byDepth.get("glance"), 1);

  const itemAfterGlance = await pool.query(
    `SELECT id, active_generation_id FROM kith.source_items WHERE source_account_id = $1`,
    [accountId],
  );
  assert.equal(itemAfterGlance.rows.length, 1, "expected exactly one source item after the glance ingest");
  const sourceItemId = itemAfterGlance.rows[0].id;
  const glanceGenerationId = itemAfterGlance.rows[0].active_generation_id;
  assert.ok(glanceGenerationId, "source item has no active generation after the glance ingest");

  const glanceDocumentRow = await pool.query(
    `SELECT id FROM kith.documents WHERE processing_generation_id = $1`,
    [glanceGenerationId],
  );
  assert.equal(glanceDocumentRow.rows.length, 1);

  const readClient1 = await pool.connect();
  let glanceDocument;
  try {
    glanceDocument = await documents.getDocument(readClient1, [spaceId], glanceDocumentRow.rows[0].id);
  } finally {
    readClient1.release();
  }
  assert.ok(glanceDocument, "getDocument returned null for the glance-depth document");
  assert.equal(glanceDocument.pages.length, 1, "glance depth must store exactly page 1");
  assert.match(glanceDocument.pages[0].text, /Form W-2 Wage and Tax Statement/);
  assert.doesNotMatch(glanceDocument.pages[0].text, /Employer copy continuation/);
  // kind -> doc_type: see ingest.ts and documents/model.ts's effectiveDocType.
  assert.equal(glanceDocument.docType, "tax_support");
  // kind + detected tax year -> title, findable by year without touching the
  // read path (title.ts's buildTitle; the filename's own "2022" resolves
  // through detectTaxYear's bare-filename-year fallback).
  assert.equal(glanceDocument.title, "Tax support 2022 · 2022 W-2.pdf");

  const glanceMetadata = await pool.query(
    `SELECT ingest_metadata FROM kith.source_items WHERE id = $1`,
    [sourceItemId],
  );
  assert.deepEqual(glanceMetadata.rows[0].ingest_metadata, {
    pageCount: 2,
    byteLength: pdf.length,
    taxYear: 2022,
    kind: "tax_support",
    depth: "glance",
    converter: glanceMetadata.rows[0].ingest_metadata.converter,
  });
  assert.match(glanceMetadata.rows[0].ingest_metadata.converter, /^pdftotext-poppler@/);

  // Re-running with the same auto policy is idempotent: unchanged bytes,
  // unchanged (glance) depth.
  const second = await runIngest(pool, autoOptions, log);
  assert.equal(second.failed, 0);
  assert.equal(second.newCount, 0);
  assert.equal(second.promoted, 0);
  assert.equal(second.skippedUnchanged, 1);

  const itemStillGlance = await pool.query(
    `SELECT active_generation_id FROM kith.source_items WHERE id = $1`,
    [sourceItemId],
  );
  assert.equal(
    itemStillGlance.rows[0].active_generation_id,
    glanceGenerationId,
    "an unchanged auto re-run must not mint a new generation",
  );

  // `--depth full` promotes the same source item: same bytes, a new full
  // generation.
  const fullOptions = { ...autoOptions, depth: "full" };
  const third = await runIngest(pool, fullOptions, log);
  assert.equal(third.failed, 0, `expected no failures: ${JSON.stringify(third.failures)}`);
  assert.equal(third.newCount, 0, "a promotion is not counted as newCount");
  assert.equal(third.promoted, 1, "the summary must count the promotion");
  assert.equal(third.byKind.get("tax_support"), 1);
  assert.equal(third.byDepth.get("full"), 1);

  const itemAfterFull = await pool.query(
    `SELECT id, active_generation_id FROM kith.source_items WHERE source_account_id = $1`,
    [accountId],
  );
  assert.equal(itemAfterFull.rows.length, 1, "promotion must reuse the same source item, not create a second one");
  assert.equal(itemAfterFull.rows[0].id, sourceItemId);
  const fullGenerationId = itemAfterFull.rows[0].active_generation_id;
  assert.ok(fullGenerationId, "source item has no active generation after promotion");
  assert.notEqual(fullGenerationId, glanceGenerationId, "promotion must mint a new generation, not reuse the glance one");

  const generationCount = await pool.query(
    `SELECT count(*)::int AS count FROM kith.processing_generations WHERE source_item_id = $1`,
    [sourceItemId],
  );
  assert.equal(generationCount.rows[0].count, 2, "expected the original glance generation plus the new full one");

  const glanceGenerationAfter = await pool.query(
    `SELECT deactivated_at FROM kith.processing_generations WHERE id = $1`,
    [glanceGenerationId],
  );
  assert.ok(glanceGenerationAfter.rows[0].deactivated_at, "the glance generation should be deactivated, not deleted");

  const fullDocumentRow = await pool.query(
    `SELECT id FROM kith.documents WHERE processing_generation_id = $1`,
    [fullGenerationId],
  );
  assert.equal(fullDocumentRow.rows.length, 1);

  const readClient2 = await pool.connect();
  let fullDocument;
  try {
    fullDocument = await documents.getDocument(readClient2, [spaceId], fullDocumentRow.rows[0].id);
  } finally {
    readClient2.release();
  }
  assert.ok(fullDocument, "getDocument returned null for the promoted full document");
  assert.equal(fullDocument.pages.length, 2, "full depth must store every page");
  assert.match(fullDocument.pages[0].text, /Form W-2 Wage and Tax Statement/);
  assert.match(fullDocument.pages[1].text, /Employer copy continuation/);
  assert.equal(fullDocument.title, "Tax support 2022 · 2022 W-2.pdf");

  // ingest_metadata is updated in place on the same source_items row, not a
  // second row, and its `depth` now reads "full".
  const fullMetadata = await pool.query(
    `SELECT ingest_metadata FROM kith.source_items WHERE id = $1`,
    [sourceItemId],
  );
  assert.deepEqual(fullMetadata.rows[0].ingest_metadata, {
    pageCount: 2,
    byteLength: pdf.length,
    taxYear: 2022,
    kind: "tax_support",
    depth: "full",
    converter: fullMetadata.rows[0].ingest_metadata.converter,
  });
  assert.match(fullMetadata.rows[0].ingest_metadata.converter, /^pdftotext-poppler@/);

  // Re-running --depth full again is idempotent: same bytes, already full
  // (never demotes, never reprocesses).
  const fourth = await runIngest(pool, fullOptions, log);
  assert.equal(fourth.failed, 0);
  assert.equal(fourth.newCount, 0);
  assert.equal(fourth.promoted, 0);
  assert.equal(fourth.skippedUnchanged, 1);

  const generationCountAfter = await pool.query(
    `SELECT count(*)::int AS count FROM kith.processing_generations WHERE source_item_id = $1`,
    [sourceItemId],
  );
  assert.equal(generationCountAfter.rows[0].count, 2, "a repeated full run must not mint another generation");
});

// A fake `pdftotext`/`pdfinfo` placed first on PATH for the two tests below:
// no PDF-encryption tool (`qpdf`, `pdftk`) is available in this environment
// to build a real password-protected PDF fixture. Both fakes read the
// fixture file's first line as "the password this document requires" (empty
// means "no password needed") -- a convention only these tests share, not a
// real PDF format detail. See test/convertEncryptedPdf.test.mjs for the same
// pattern exercised against convert.ts directly.
const ENCRYPTED_PAGE_ONE = "Form 1099-DIV Dividends and Distributions for 2022, well over forty characters.";
const REAL_PASSWORD = "correct-horse-battery-staple";

const PDFTOTEXT_FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-v")) {
  process.stderr.write("pdftotext version 99.0.0 (fake, test-only)\\n");
  process.exit(1);
}
const path = args[args.length - 2];
const expected = fs.readFileSync(path, "utf8").split("\\n")[0].trim();
const upwIndex = args.indexOf("-upw");
const provided = upwIndex >= 0 ? args[upwIndex + 1] : undefined;
if (expected && provided !== expected) {
  process.stderr.write("Command Line Error: Incorrect password\\n");
  process.exit(1);
}
process.stdout.write(${JSON.stringify(ENCRYPTED_PAGE_ONE)});
`;

const PDFINFO_FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const path = args[args.length - 1];
const expected = fs.readFileSync(path, "utf8").split("\\n")[0].trim();
const upwIndex = args.indexOf("-upw");
const provided = upwIndex >= 0 ? args[upwIndex + 1] : undefined;
if (expected && provided !== expected) {
  process.stderr.write("Command Line Error: Incorrect password\\n");
  process.exit(1);
}
process.stdout.write("Pages: 1\\n");
`;

async function withFakePoppler(t) {
  const dir = await mkdtemp(join(tmpdir(), "ingest-simple-fake-poppler-"));
  const pdftotextPath = join(dir, "pdftotext");
  const pdfinfoPath = join(dir, "pdfinfo");
  await writeFile(pdftotextPath, PDFTOTEXT_FAKE, "utf8");
  await writeFile(pdfinfoPath, PDFINFO_FAKE, "utf8");
  await chmod(pdftotextPath, 0o755);
  await chmod(pdfinfoPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
  t.after(async () => {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  });
}

test("an encrypted PDF with no working password registers at glance depth with no page text, counted as encrypted", { skip }, async (t) => {
  const { pool, spaceId, accountId } = await bootstrapDatabase(t);
  await withFakePoppler(t);

  const root = await mkdtemp(join(tmpdir(), "ingest-simple-encrypted-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileName = "2022 1099-DIV.pdf";
  // First line is the fake pdftotext/pdfinfo's required password -- not real
  // PDF bytes.
  const fileBytes = Buffer.from(`${REAL_PASSWORD}\nfake encrypted pdf body\n`, "utf8");
  await writeFile(join(root, fileName), fileBytes);

  const log = () => {};
  const options = {
    root,
    sourceAccountId: accountId,
    dryRun: false,
    concurrency: 1,
    depth: "auto",
    fullMatchPatterns: [],
    pdfPasswords: [],
  };

  const first = await runIngest(pool, options, log);
  assert.equal(first.failed, 0, `expected no failures: ${JSON.stringify(first.failures)}`);
  assert.equal(first.encrypted, 1);
  assert.equal(first.newCount, 1, "an encrypted registration still counts as a new document");
  assert.equal(first.byDepth.get("glance"), 1);

  const item = await pool.query(
    `SELECT id, active_generation_id, ingest_metadata FROM kith.source_items WHERE source_account_id = $1`,
    [accountId],
  );
  assert.equal(item.rows.length, 1);
  assert.ok(item.rows[0].active_generation_id, "source item has no active generation after ingest");
  assert.deepEqual(item.rows[0].ingest_metadata, {
    pageCount: null,
    byteLength: fileBytes.length,
    // Filename-only classification: no page text was ever read.
    taxYear: 2022,
    kind: "tax_support",
    depth: "glance",
    converter: "encrypted-pdf-unreadable-v1",
    encrypted: true,
  });

  const documentRow = await pool.query(
    `SELECT id, title FROM kith.documents WHERE processing_generation_id = $1`,
    [item.rows[0].active_generation_id],
  );
  assert.equal(documentRow.rows.length, 1);
  assert.equal(documentRow.rows[0].title, "Tax support 2022 · 2022 1099-DIV.pdf");

  const readClient = await pool.connect();
  let document;
  try {
    document = await documents.getDocument(readClient, [spaceId], documentRow.rows[0].id);
  } finally {
    readClient.release();
  }
  assert.ok(document, "getDocument returned null for the encrypted-PDF registration");
  assert.equal(document.pages.length, 1);
  assert.equal(document.pages[0].text, "", "an unopened encrypted PDF must not fabricate page text");

  // A second run with the same (still no) password is idempotent: unchanged
  // bytes, unchanged (glance) depth -- not re-counted as encrypted again.
  const second = await runIngest(pool, options, log);
  assert.equal(second.failed, 0);
  assert.equal(second.encrypted, 0);
  assert.equal(second.skippedUnchanged, 1);
});

test("an encrypted PDF opens normally when the correct --pdf-password is supplied", { skip }, async (t) => {
  const { pool, accountId } = await bootstrapDatabase(t);
  await withFakePoppler(t);

  const root = await mkdtemp(join(tmpdir(), "ingest-simple-encrypted-password-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileName = "2022 1099-DIV.pdf";
  const fileBytes = Buffer.from(`${REAL_PASSWORD}\nfake encrypted pdf body\n`, "utf8");
  await writeFile(join(root, fileName), fileBytes);

  const log = () => {};
  const options = {
    root,
    sourceAccountId: accountId,
    dryRun: false,
    concurrency: 1,
    depth: "auto",
    fullMatchPatterns: [],
    pdfPasswords: ["wrong-guess", REAL_PASSWORD],
  };

  const result = await runIngest(pool, options, log);
  assert.equal(result.failed, 0, `expected no failures: ${JSON.stringify(result.failures)}`);
  assert.equal(result.encrypted, 0, "a password that opens the file must not be counted as encrypted");
  assert.equal(result.newCount, 1);

  const item = await pool.query(
    `SELECT ingest_metadata FROM kith.source_items WHERE source_account_id = $1`,
    [accountId],
  );
  assert.equal(item.rows[0].ingest_metadata.encrypted, undefined);
  assert.equal(item.rows[0].ingest_metadata.pageCount, 1);
});

test("write.ts's ingestFile refuses a second write whose extracted text matches but whose file facts do not, as a distinct RevisionConflictError", { skip }, async (t) => {
  const { pool, spaceId, userId, accountId } = await bootstrapDatabase(t);

  // Same externalId (same source item), same extracted `pages` text (so
  // `createOrGetRevision`'s `content_hash` matches), but a different
  // `fileByteHash`/`capturedAt` -- the scenario write.ts's
  // `RevisionConflictError` doc comment describes: a file re-saved with
  // different bytes that happens to extract to the exact same text. Calling
  // `ingestFile` directly (the ingester's write path, bypassing ingest.ts's
  // own file-hash skip check) reproduces it deterministically.
  const externalId = "conflicting-revision.pdf";
  const pages = ["Statement text that stays exactly the same across both writes."];

  const first = await ingestFile(pool, {
    spaceId,
    sourceAccountId: accountId,
    externalId,
    title: "Statement",
    docType: "statement",
    capturedAt: new Date("2022-01-01T00:00:00Z"),
    userId,
    fileByteHash: sha256("first-file-bytes"),
    pages,
    converterFingerprint: "test-revision-conflict-v1",
    mediaType: "text/plain",
  });
  assert.ok(first.sourceItemId);

  await assert.rejects(
    () =>
      ingestFile(pool, {
        spaceId,
        sourceAccountId: accountId,
        externalId,
        title: "Statement",
        docType: "statement",
        // Different modified time and different file bytes; same extracted
        // text.
        capturedAt: new Date("2022-06-01T00:00:00Z"),
        userId,
        fileByteHash: sha256("second-file-bytes"),
        pages,
        converterFingerprint: "test-revision-conflict-v1",
        mediaType: "text/plain",
      }),
    (error) => {
      assert.ok(error instanceof RevisionConflictError, `expected RevisionConflictError, got ${error}`);
      assert.match(error.message, /conflicting-revision\.pdf/);
      return true;
    },
  );

  // The refused write left no trace: still exactly one revision and one
  // generation for this source item -- the store's immutability check held,
  // and the failed transaction rolled back cleanly.
  const revisionCount = await pool.query(
    `SELECT count(*)::int AS count FROM kith.source_revisions WHERE source_item_id = $1`,
    [first.sourceItemId],
  );
  assert.equal(revisionCount.rows[0].count, 1);
  const generationCount = await pool.query(
    `SELECT count(*)::int AS count FROM kith.processing_generations WHERE source_item_id = $1`,
    [first.sourceItemId],
  );
  assert.equal(generationCount.rows[0].count, 1);
});

test("ingesting a synthetic document registers and embeds its chunks when the space has an active embedding generation and the provider is configured", { skip }, async (t) => {
  const { pool, spaceId, accountId } = await bootstrapDatabase(t);

  const stub = await startEmbeddingStub();
  t.after(() => stub.stop());
  const env = stubEmbeddingEnv(stub);
  const { fingerprint } = await activateEmptyEmbeddingGeneration(pool, spaceId, env);
  withProcessEnv(t, env);

  const root = await mkdtemp(join(tmpdir(), "ingest-simple-embed-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdf = buildPdf(["Statement page one.\nAccount ending 1234."]);
  await writeFile(join(root, "statement.pdf"), pdf);

  const log = () => {};
  const summary = await runIngest(
    pool,
    { root, sourceAccountId: accountId, dryRun: false, concurrency: 1, depth: "full", fullMatchPatterns: [] },
    log,
  );
  assert.equal(summary.failed, 0, `expected no failures: ${JSON.stringify(summary.failures)}`);
  assert.equal(summary.newCount, 1);

  const item = await pool.query(
    `SELECT active_generation_id FROM kith.source_items WHERE source_account_id = $1`,
    [accountId],
  );
  const generationId = item.rows[0].active_generation_id;
  const chunkRows = await pool.query(
    `SELECT id FROM kith.chunks WHERE processing_generation_id = $1`,
    [generationId],
  );
  assert.ok(chunkRows.rows.length > 0, "expected at least one chunk for the ingested document");
  const chunkIds = chunkRows.rows.map((row) => row.id);

  const targetRows = await pool.query(
    `SELECT target_id, state, covered_fingerprint FROM kith.embedding_targets
      WHERE space_id = $1 AND target_kind = 'chunk' AND target_id = ANY($2::text[])`,
    [spaceId, chunkIds],
  );
  assert.equal(targetRows.rows.length, chunkIds.length, "every chunk must have an embedding_targets row");
  for (const target of targetRows.rows) {
    assert.equal(target.state, "eligible");
    assert.equal(target.covered_fingerprint, fingerprint, "the target must be covered by the active fingerprint");
  }

  const vectorRows = await pool.query(
    `SELECT chunk_id, embedding_fingerprint FROM kith.embedding_vectors
      WHERE space_id = $1 AND target_kind = 'chunk' AND chunk_id = ANY($2::text[])`,
    [spaceId, chunkIds],
  );
  assert.equal(vectorRows.rows.length, chunkIds.length, "every chunk must have an embedding_vectors row");
  for (const vector of vectorRows.rows) {
    assert.equal(vector.embedding_fingerprint, fingerprint);
  }
  assert.ok(stub.callCount() >= chunkIds.length, "the stub provider must have been called at least once per chunk");
});

test("a steady-state re-run with no new files still retries an eligible-but-uncovered chunk once the provider is configured", { skip }, async (t) => {
  const { pool, spaceId, accountId } = await bootstrapDatabase(t);

  const stub = await startEmbeddingStub();
  t.after(() => stub.stop());
  const env = stubEmbeddingEnv(stub);
  const { fingerprint } = await activateEmptyEmbeddingGeneration(pool, spaceId, env);

  const root = await mkdtemp(join(tmpdir(), "ingest-simple-steady-state-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdf = buildPdf(["Statement page one.\nAccount ending 4242."]);
  await writeFile(join(root, "statement.pdf"), pdf);

  const options = { root, sourceAccountId: accountId, dryRun: false, concurrency: 1, depth: "full", fullMatchPatterns: [] };
  const log = () => {};

  // First run: no provider configured in `process.env` yet. The document
  // ingests and its chunk's target is registered but left uncovered -- same
  // setup as the backfill test above.
  const first = await runIngest(pool, options, log);
  assert.equal(first.failed, 0);
  assert.equal(first.newCount, 1);

  const item = await pool.query(
    `SELECT active_generation_id FROM kith.source_items WHERE source_account_id = $1`,
    [accountId],
  );
  const generationId = item.rows[0].active_generation_id;
  const chunkRows = await pool.query(`SELECT id FROM kith.chunks WHERE processing_generation_id = $1`, [generationId]);
  const chunkIds = chunkRows.rows.map((row) => row.id);
  assert.ok(chunkIds.length > 0);

  const beforeVectors = await pool.query(
    `SELECT count(*)::int AS count FROM kith.embedding_vectors WHERE space_id = $1 AND chunk_id = ANY($2::text[])`,
    [spaceId, chunkIds],
  );
  assert.equal(beforeVectors.rows[0].count, 0, "no vector must exist before the provider is configured");

  // The operator now fixes the provider configuration (e.g. re-runs with
  // `--env-from-keychain`), but the file itself is unchanged: this second run
  // ingests nothing new (`newCount` 0, `skippedUnchanged` 1). Before the
  // `activatedThisRun > 0` gate was removed from ingest.ts, this run would
  // never have called `runPostProcessing` at all, and the chunk registered by
  // the first run would stay uncovered forever.
  withProcessEnv(t, env);
  const second = await runIngest(pool, options, log);
  assert.equal(second.failed, 0);
  assert.equal(second.newCount, 0, "the unchanged file must not be re-ingested");
  assert.equal(second.skippedUnchanged, 1);

  const afterVectors = await pool.query(
    `SELECT chunk_id, embedding_fingerprint FROM kith.embedding_vectors
      WHERE space_id = $1 AND target_kind = 'chunk' AND chunk_id = ANY($2::text[])`,
    [spaceId, chunkIds],
  );
  assert.equal(
    afterVectors.rows.length,
    chunkIds.length,
    "a steady-state run must still retry and cover a previously-uncovered chunk",
  );
  for (const vector of afterVectors.rows) {
    assert.equal(vector.embedding_fingerprint, fingerprint);
  }
});

test("--backfill-embeddings adds vectors for a generation that was activated before the document was embedded", { skip }, async (t) => {
  const { pool, spaceId, accountId } = await bootstrapDatabase(t);

  const stub = await startEmbeddingStub();
  t.after(() => stub.stop());
  const env = stubEmbeddingEnv(stub);
  // The generation is active on an empty catalog *before* anything is
  // ingested -- "a generation that was activated without them" (the task's
  // own framing): the space is already counted and has an active
  // fingerprint, same as the real deployment's one-time bootstrap, before
  // this account's first document exists.
  const { fingerprint } = await activateEmptyEmbeddingGeneration(pool, spaceId, env);

  const root = await mkdtemp(join(tmpdir(), "ingest-simple-backfill-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdf = buildPdf(["Statement page one.\nAccount ending 9999."]);
  await writeFile(join(root, "statement.pdf"), pdf);

  // Ingested with no provider configured in `process.env` (README's "Running
  // from a shell with no provider configured"): the default OpenAI endpoint
  // has no API key, so the inline fill fails with "provider unavailable" and
  // the chunk's target is left eligible but uncovered -- registered, not
  // embedded.
  const log = () => {};
  const summary = await runIngest(
    pool,
    { root, sourceAccountId: accountId, dryRun: false, concurrency: 1, depth: "full", fullMatchPatterns: [] },
    log,
  );
  assert.equal(summary.failed, 0, `expected no failures: ${JSON.stringify(summary.failures)}`);

  const item = await pool.query(
    `SELECT active_generation_id FROM kith.source_items WHERE source_account_id = $1`,
    [accountId],
  );
  const generationId = item.rows[0].active_generation_id;
  const chunkRows = await pool.query(
    `SELECT id FROM kith.chunks WHERE processing_generation_id = $1`,
    [generationId],
  );
  assert.ok(chunkRows.rows.length > 0);
  const chunkIds = chunkRows.rows.map((row) => row.id);

  const beforeTargets = await pool.query(
    `SELECT covered_fingerprint FROM kith.embedding_targets
      WHERE space_id = $1 AND target_kind = 'chunk' AND target_id = ANY($2::text[])`,
    [spaceId, chunkIds],
  );
  assert.equal(beforeTargets.rows.length, chunkIds.length, "the target must already be registered from ingest");
  for (const target of beforeTargets.rows) {
    assert.equal(target.covered_fingerprint, null, "the target must not be covered yet");
  }
  const beforeVectors = await pool.query(
    `SELECT count(*)::int AS count FROM kith.embedding_vectors WHERE space_id = $1 AND chunk_id = ANY($2::text[])`,
    [spaceId, chunkIds],
  );
  assert.equal(beforeVectors.rows[0].count, 0, "no vector must exist before the backfill runs");

  const backfillLog = () => {};
  const result = await backfillEmbeddings(pool, accountId, env, backfillLog);
  assert.equal(result.embeddings.failed, false, "the backfill's embedding fill must not fail against the stub");
  assert.ok(result.embeddings.embedded >= chunkIds.length, "the backfill must embed every owed chunk");

  const afterVectors = await pool.query(
    `SELECT chunk_id, embedding_fingerprint FROM kith.embedding_vectors
      WHERE space_id = $1 AND target_kind = 'chunk' AND chunk_id = ANY($2::text[])`,
    [spaceId, chunkIds],
  );
  assert.equal(afterVectors.rows.length, chunkIds.length, "every chunk must have a vector after the backfill");
  for (const vector of afterVectors.rows) {
    assert.equal(vector.embedding_fingerprint, fingerprint);
  }

  const afterTargets = await pool.query(
    `SELECT covered_fingerprint FROM kith.embedding_targets
      WHERE space_id = $1 AND target_kind = 'chunk' AND target_id = ANY($2::text[])`,
    [spaceId, chunkIds],
  );
  for (const target of afterTargets.rows) {
    assert.equal(target.covered_fingerprint, fingerprint);
  }

  // Re-running the backfill is idempotent: nothing left to embed, so the
  // provider is not called again for these chunks.
  const callsBeforeSecondRun = stub.callCount();
  const second = await backfillEmbeddings(pool, accountId, env, backfillLog);
  assert.equal(second.embeddings.embedded, 0, "a second backfill must not re-embed already-covered chunks");
  assert.equal(stub.callCount(), callsBeforeSecondRun, "a second backfill must not call the provider again");
});
