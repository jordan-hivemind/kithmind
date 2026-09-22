// Proves the `--bindings`/`--root-alias` transition this package needs for a
// folder the old durable filesystem worker already indexed
// (`packages/pipeline`, frozen): a file the old worker registered under a
// random UUID `externalId` must resolve to the *same* `kith.source_items`
// row when ingest-simple runs against it with that UUID bound, not a second
// item keyed by the file's path.
//
// Step 1 simulates what the old worker left behind: `createOrGetSourceItem`
// with a UUID external id, then `createOrGetArchivedRevision`
// (`@repo/kith-store`'s provenance/binary.ts) -- the archived-binary
// representation the old worker's PDF lane used -- with no active
// generation. Building a full active generation on that archived revision
// would require reconstructing the old worker's own parsed-staging session
// (`kith.worker_parsed_stages`) and a real `kith.brain_api_keys` row (see the
// large comment at the top of ../src/write.ts), which is exactly the durable
// -worker machinery this package replaces, so this test uses the item's
// bare-minimum resting state instead: registered, with an archived revision,
// never activated -- itself a realistic state for a file the old worker
// catalogued but a paused/parked pass never finished parsing.
//
// Step 2 runs this package's own `ingestFile` (../src/write.ts) for the same
// file, passing that same UUID as `externalId` -- what happens when
// `--bindings`/`--root-alias` (see ../src/bindings.ts) resolves the file's
// `relativePath` to it -- and asserts: no second source item exists for that
// space and account, the new *inline* generation `ingestFile` staged is
// active, and `documents.getDocument` returns its pages.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  applyKithSchema,
  createKithPool,
  documents,
  newKithId,
  provenance,
  sha256,
  withKithTransaction,
} from "@repo/kith-store";
import { ingestFile } from "../dist/write.js";

import { acquirePostgres, skip } from "./helpers/pgServer.mjs";

async function bootstrapDatabase(t) {
  const server = await acquirePostgres();
  const pool = createKithPool(server.url, 4);
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

test(
  "a file bound to the old worker's UUID external id reuses its source item instead of creating a second one",
  { skip },
  async (t) => {
    const { pool, spaceId, userId, accountId } = await bootstrapDatabase(t);

    const relativePath = "Statements/2025/january.pdf";
    const boundExternalId = randomUUID();
    const fileBytes = Buffer.from("%PDF-1.4 synthetic statement bytes for the binding transition test");
    const fileByteHash = sha256(fileBytes);

    // Step 1: register the item the old worker's way.
    const legacyItem = await withKithTransaction(pool, async (client) => {
      const item = await provenance.createOrGetSourceItem(client, {
        spaceId,
        sourceAccountId: accountId,
        externalId: boundExternalId,
        title: "January",
        docType: "pdf",
      });
      await provenance.createOrGetArchivedRevision(client, {
        spaceId,
        sourceItemId: item.id,
        contentHash: fileByteHash,
        byteLength: fileBytes.byteLength,
        mediaType: "application/pdf",
        capturedAt: new Date(),
        userId,
      });
      return item;
    });

    const legacyRow = await pool.query(
      `SELECT id, active_generation_id, external_id FROM kith.source_items WHERE space_id = $1 AND source_account_id = $2`,
      [spaceId, accountId],
    );
    assert.equal(legacyRow.rows.length, 1, "expected exactly one source item after the legacy registration");
    assert.equal(legacyRow.rows[0].external_id, boundExternalId);
    assert.equal(
      legacyRow.rows[0].active_generation_id,
      null,
      "the legacy item should have no active generation before ingest-simple runs",
    );

    const legacyRevisionRepresentation = await pool.query(
      `SELECT representation FROM kith.source_revisions WHERE source_item_id = $1`,
      [legacyItem.id],
    );
    assert.equal(legacyRevisionRepresentation.rows.length, 1);
    assert.equal(legacyRevisionRepresentation.rows[0].representation, "archived_binary_v1");

    // Step 2: ingest-simple runs against the same file, with `--bindings`
    // having resolved `relativePath` -> `boundExternalId` (what
    // ../src/bindings.ts + ingest.ts's `externalIdBindings` lookup do; see
    // ../src/ingest.ts for the `bound ?? file.relativePath` fallback this
    // input mirrors directly).
    const pages = [
      "Statement page one.\nAccount ending 4321.",
      "Statement page two.\nClosing balance $1,200.00.",
    ];
    const result = await ingestFile(pool, {
      spaceId,
      sourceAccountId: accountId,
      externalId: boundExternalId,
      title: "January",
      docType: "pdf",
      capturedAt: new Date(),
      userId,
      fileByteHash,
      pages,
      converterFingerprint: "test-binding-transition-v1",
      mediaType: "application/pdf",
    });
    assert.equal(result.sourceItemId, legacyItem.id, "ingestFile created a different source item than the legacy one");

    // No second source item for this space/account: still exactly one row.
    const afterRow = await pool.query(
      `SELECT id, active_generation_id FROM kith.source_items WHERE space_id = $1 AND source_account_id = $2`,
      [spaceId, accountId],
    );
    assert.equal(afterRow.rows.length, 1, "a second source item was created for the bound file");
    assert.equal(afterRow.rows[0].id, legacyItem.id);
    assert.ok(afterRow.rows[0].active_generation_id, "the item has no active generation after ingestFile");
    assert.equal(afterRow.rows[0].active_generation_id, result.processingGenerationId);

    // The active generation's revision is the new inline one, distinct from
    // the legacy archived revision, and both now coexist on one item.
    const revisions = await pool.query(
      `SELECT id, representation FROM kith.source_revisions WHERE source_item_id = $1 ORDER BY created_at`,
      [legacyItem.id],
    );
    assert.equal(revisions.rows.length, 2, "expected the legacy archived revision plus one new inline revision");
    assert.equal(revisions.rows[0].representation, "archived_binary_v1");
    assert.equal(
      revisions.rows[1].representation,
      null,
      "the new revision should be the implicit-legacy inline_utf8_v1 shape ingest-simple writes",
    );

    const generationRow = await pool.query(
      `SELECT state, source_revision_id FROM kith.processing_generations WHERE id = $1`,
      [result.processingGenerationId],
    );
    assert.equal(generationRow.rows.length, 1);
    assert.equal(generationRow.rows[0].state, "ready");
    assert.equal(generationRow.rows[0].source_revision_id, revisions.rows[1].id);

    // getDocument returns the pages, through the same read path the product
    // uses.
    const readClient = await pool.connect();
    let document;
    try {
      document = await documents.getDocument(readClient, [spaceId], result.documentId);
    } finally {
      readClient.release();
    }
    assert.ok(document, "getDocument returned null for the bound-identity document");
    assert.equal(document.pages.length, 2);
    assert.match(document.pages[0].text, /page one/i);
    assert.match(document.pages[1].text, /page two/i);
  },
);
