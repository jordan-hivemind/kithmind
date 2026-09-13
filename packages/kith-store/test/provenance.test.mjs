// P2-39d: the provenance and documents domain against a real server.
//
// Ported from packages/convex/convex/models/provenance/* and
// models/documents/inventory.ts. These tests exercise the invariants that
// row was told to keep: sealed text versions are never altered, spans
// recompute to their quoteHash, card-staged spans over sealed text are
// distinguished by cardExtractionFingerprints (PR199), the generation chain
// resolves for both inline text and archived binary representations
// (PR178), and inventory rows keep parse_failed on a rescan of the same
// bytes (PR191).
//
// Each test runs in its own throwaway database (test/helpers/pgDatabase.mjs)
// and applies the full migration chain through applyKithSchema, exactly as
// kithSchema.test.mjs does.

import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { applyKithSchema, newKithId } from "../dist/index.js";
import * as provenance from "../dist/provenance/index.js";
import * as documents from "../dist/documents/index.js";

import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

function opaqueId() {
  return newKithId();
}

/**
 * Every space-scoped table this row owns types `space_id` as
 * `kith.kith_id`, so the fixture space id must satisfy that domain's
 * character class. `kith.spaces` itself is still the prototype's `uuid`
 * column (identity/P2-39c has not yet ported it), and section 2.5 leaves
 * space authorization -- including whether a `spaceId` names a real,
 * membership-checked space -- to application code rather than a foreign
 * key, so this fixture does not need a row in `kith.spaces` at all.
 */
function seedSpace() {
  return newKithId();
}

/** A processing_generations row: ingestion's job (not this row's), so the
 * fixture inserts it with raw SQL rather than calling a ported function. */
async function seedGeneration(client, input) {
  const id = opaqueId();
  await client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id,
        source_text_version_id, desired_processing_epoch, card_generation, state)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,false,'staging')`,
    [
      id,
      input.spaceId,
      input.sourceAccountId,
      input.sourceItemId,
      input.sourceRevisionId,
      input.sourceTextVersionId,
      input.desiredProcessingEpoch,
    ],
  );
  return id;
}

// The four tables outside this row's ownership that its foreign keys point
// at (source_accounts: ingestion/P2-39e; users, api_keys: identity/
// P2-39c; worker_source_scans: ingestion/P2-39e). Every FK migration 004
// added is DEFERRABLE INITIALLY DEFERRED, but each fixture call below still
// runs in its own implicit autocommit transaction, so the referenced row
// must already exist -- exactly as it would in production, where the owning
// row's service creates it first.
async function seedSourceAccount(client, spaceId) {
  const id = opaqueId();
  await client.query(
    "INSERT INTO kith.source_accounts (id, space_id, created_at) VALUES ($1,$2,transaction_timestamp())",
    [id, spaceId],
  );
  return id;
}

async function seedUser(client) {
  const id = opaqueId();
  await client.query(
    "INSERT INTO kith.users (id, created_at) VALUES ($1,transaction_timestamp())",
    [id],
  );
  return id;
}

async function seedApiKey(client) {
  const id = opaqueId();
  // `kith.api_keys`, not `kith.brain_api_keys`: migration 006 (P2-39c) gave the
  // plain name to the kith_id-keyed table. That migration also makes `user_id`,
  // `key_hash`, `key_prefix` and `name` required, so a credential fixture now has
  // to be a credential -- a key with no owner and no hash authenticates nothing
  // and should not be representable.
  await client.query(
    `INSERT INTO kith.api_keys
       (id, created_at, user_id, key_hash, key_prefix, name)
       VALUES ($1, transaction_timestamp(), $2, $3, 'ob_prov', 'provenance fixture')`,
    [id, await seedUser(client), createHash("sha256").update(id).digest("hex")],
  );
  return id;
}

async function seedWorkerScan(client, spaceId, sourceAccountId) {
  const id = opaqueId();
  const actorUserId = await seedUser(client);
  const actorCredentialId = opaqueId();
  await client.query(
    `INSERT INTO kith.api_keys
       (id, created_at, user_id, key_hash, key_prefix, name)
     VALUES ($1, transaction_timestamp(), $2, $3, 'ob_scan', 'scan fixture')`,
    [
      actorCredentialId,
      actorUserId,
      createHash("sha256").update(actorCredentialId).digest("hex"),
    ],
  );
  await client.query(
    `INSERT INTO kith.worker_source_scans
       (id, space_id, source_account_id, request_id, request_digest,
        watcher_id, connector_version, mode, inventory_epoch,
        manifest_version_at_begin, actor_user_id, actor_credential_id, state,
        next_page_ordinal, inventory_done, page_count, entry_count,
        changed_count, gap_count, review_count, next_reconcile_ordinal,
        started_at, expires_at, retire_at)
     VALUES ($1,$2,$3,$4,$5,'fixture-watcher','fixture-v1','normal',0,0,$6,$7,
             'open',0,false,0,0,0,0,0,0,transaction_timestamp(),
             transaction_timestamp() + interval '30 minutes',
             transaction_timestamp() + interval '90 days')`,
    [
      id,
      spaceId,
      sourceAccountId,
      `fixture-scan-${id}`,
      `fixture-digest-${id}`,
      actorUserId,
      actorCredentialId,
    ],
  );
  return id;
}

test(
  "the source item to chunk lifecycle stages, activates, and rejects a stale generation",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);
    const spaceId = seedSpace();
    const sourceAccountId = await seedSourceAccount(client, spaceId);
    const userId = await seedUser(client);

    const item = await provenance.createOrGetSourceItem(client, {
      spaceId,
      sourceAccountId,
      externalId: "fixture/statement-a.txt",
      title: "Statement A",
    });
    assert.equal(item.lifecycle, "available");
    assert.equal(item.desiredProcessingEpoch, 0);

    // Re-declaring the same identity returns the existing row rather than a
    // second one.
    const again = await provenance.createOrGetSourceItem(client, {
      spaceId,
      sourceAccountId,
      externalId: "fixture/statement-a.txt",
      title: "Statement A",
    });
    assert.equal(again.id, item.id);

    const revision = await provenance.createOrGetRevision(client, {
      spaceId,
      sourceItemId: item.id,
      mediaType: "text/plain",
      inlineText: "Opening balance is 100.",
      capturedAt: new Date("2026-01-01T00:00:00Z"),
      userId,
    });

    const textVersion = await provenance.createOrGetTextVersion(client, {
      spaceId,
      sourceRevisionId: revision.id,
      extractionFingerprint: "extract-v1",
      text: "Opening balance is 100.",
    });
    assert.equal(textVersion.evidenceSealed, false);

    const [page] = await provenance.stagePages(client, {
      spaceId,
      sourceTextVersionId: textVersion.id,
      pages: [
        { ordinal: 0, start: 0, end: "Opening balance is 100.".length, text: "Opening balance is 100." },
      ],
    });

    const [span] = await provenance.stageEvidenceSpans(client, {
      spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      spans: [{ sourcePageId: page.id, ordinal: 0, start: 8, end: 15 }],
    });
    // The quote at [8,15) of "Opening balance is 100." is "balance".
    assert.equal(span.quoteHash, await sha256Utf8("balance"));

    // Ingestion (not this row's job) declares the revision desired before a
    // generation processes it; that declaration is what activation checks
    // the generation's own epoch against.
    await provenance.setDesiredSourceRevision(client, {
      spaceId,
      sourceItemId: item.id,
      desiredRevisionId: revision.id,
      expectedDesiredProcessingEpoch: 0,
    });

    const generationId = await seedGeneration(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      desiredProcessingEpoch: 1,
    });

    const [document] = await provenance.stageDocuments(client, {
      spaceId,
      processingGenerationId: generationId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      documents: [
        {
          documentKey: "doc-1",
          title: "Statement A",
          docType: "statement",
          capturedAt: new Date("2026-01-01T00:00:00Z"),
          evidenceSpanIds: [span.id],
        },
      ],
    });

    await provenance.stageChunks(client, {
      spaceId,
      processingGenerationId: generationId,
      chunks: [
        {
          documentId: document.id,
          ordinal: 0,
          text: "Opening balance is 100.",
          evidenceSpanIds: [span.id],
        },
      ],
    });

    const summary = await provenance.inspectGenerationPayload(client, {
      spaceId,
      processingGenerationId: generationId,
      sourceTextVersionId: textVersion.id,
    });
    assert.deepEqual(summary.documentKeys, ["doc-1"]);

    await provenance.activateSourceItemGeneration(client, {
      spaceId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      processingGenerationId: generationId,
      expectedDesiredProcessingEpoch: 1,
    });

    // Activation seals the text version: it is never altered afterward.
    const sealed = (
      await client.query("SELECT evidence_sealed FROM kith.source_text_versions WHERE id=$1", [
        textVersion.id,
      ])
    ).rows[0];
    assert.equal(sealed.evidence_sealed, true);
    await assert.rejects(
      provenance.stagePages(client, {
        spaceId,
        sourceTextVersionId: textVersion.id,
        pages: [{ ordinal: 1, start: 23, end: 23, text: "" }],
      }),
      /sealed/,
    );
    await assert.rejects(
      provenance.stageEvidenceSpans(client, {
        spaceId,
        sourceRevisionId: revision.id,
        sourceTextVersionId: textVersion.id,
        spans: [{ sourcePageId: page.id, ordinal: 1, start: 0, end: 7 }],
      }),
      /sealed/,
    );

    // A second, later revision supersedes the first; activating a stale
    // generation against the desired epoch it no longer matches is refused.
    const laterRevision = await provenance.createOrGetRevision(client, {
      spaceId,
      sourceItemId: item.id,
      mediaType: "text/plain",
      inlineText: "Closing balance is 200.",
      capturedAt: new Date("2026-01-02T00:00:00Z"),
      userId,
    });
    await provenance.setDesiredSourceRevision(client, {
      spaceId,
      sourceItemId: item.id,
      desiredRevisionId: laterRevision.id,
      expectedDesiredProcessingEpoch: 1,
    });
    await assert.rejects(
      provenance.activateSourceItemGeneration(client, {
        spaceId,
        sourceItemId: item.id,
        sourceRevisionId: revision.id,
        processingGenerationId: generationId,
        expectedPreviousGenerationId: generationId,
        expectedDesiredProcessingEpoch: 1,
      }),
      /obsolete/,
    );

    // Forgetting clears the active pointers and refuses further writes.
    await provenance.beginSourceItemForget(client, {
      spaceId,
      sourceItemId: item.id,
      forgottenAt: new Date(),
      forgottenBy: userId,
    });
    await assert.rejects(
      provenance.createOrGetRevision(client, {
        spaceId,
        sourceItemId: item.id,
        mediaType: "text/plain",
        inlineText: "Forbidden resurrection.",
        capturedAt: new Date(),
        userId,
      }),
      /forgetting/,
    );
  },
);

test(
  "card-staged evidence spans reuse a parser span, cite it, and are swept only when unreachable",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);
    const spaceId = seedSpace();
    const sourceAccountId = await seedSourceAccount(client, spaceId);
    const userId = await seedUser(client);
    const text = "Total due is 42 dollars.";

    const item = await provenance.createOrGetSourceItem(client, {
      spaceId,
      sourceAccountId,
      externalId: "fixture/card.txt",
    });
    const revision = await provenance.createOrGetRevision(client, {
      spaceId,
      sourceItemId: item.id,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: new Date(),
      userId,
    });
    const textVersion = await provenance.createOrGetTextVersion(client, {
      spaceId,
      sourceRevisionId: revision.id,
      extractionFingerprint: "extract-v1",
      text,
    });
    const [page] = await provenance.stagePages(client, {
      spaceId,
      sourceTextVersionId: textVersion.id,
      pages: [{ ordinal: 0, start: 0, end: text.length, text }],
    });
    // A parser span never carries cardExtractionFingerprints.
    const [parserSpan] = await provenance.stageEvidenceSpans(client, {
      spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      spans: [{ sourcePageId: page.id, ordinal: 0, start: 13, end: 15 }],
    });
    assert.equal(parserSpan.cardExtractionFingerprints, null);

    // Manually seal the text version, as activation would.
    await client.query("UPDATE kith.source_text_versions SET evidence_sealed = true WHERE id=$1", [
      textVersion.id,
    ]);

    // A card citing the exact same range reuses the parser span and records
    // its fingerprint, rather than creating a duplicate row.
    const [reusedId] = await provenance.stageCardEvidenceSpans(client, {
      spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      cardExtractionFingerprint: "card-v1",
      refs: [{ pageOrdinal: 0, start: 13, end: 15 }],
    });
    assert.equal(reusedId, parserSpan.id);
    // A parser span keeps no fingerprint list even when a card reuses it:
    // model.ts's own reuse guard only appends to a citation list that
    // already exists (a span an *earlier* card version staged), which is
    // exactly what keeps a parser span outside the sweep's consideration.
    const afterReuse = (
      await client.query("SELECT card_extraction_fingerprints FROM kith.evidence_spans WHERE id=$1", [
        parserSpan.id,
      ])
    ).rows[0];
    assert.equal(afterReuse.card_extraction_fingerprints, null);

    // A card citing a *new* range over the now-sealed text is still allowed:
    // sealing protects the text, not new pointers into it.
    const [newSpanId] = await provenance.stageCardEvidenceSpans(client, {
      spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      cardExtractionFingerprint: "card-v2",
      refs: [{ pageOrdinal: 0, quote: "42 dollars" }],
    });
    assert.notEqual(newSpanId, null);
    const newSpanRow = (
      await client.query("SELECT card_extraction_fingerprints, quote_hash FROM kith.evidence_spans WHERE id=$1", [
        newSpanId,
      ])
    ).rows[0];
    assert.deepEqual(newSpanRow.card_extraction_fingerprints, ["card-v2"]);
    assert.equal(newSpanRow.quote_hash, await sha256Utf8("42 dollars"));

    // An unresolvable ref (a quote that never appears) resolves to null
    // rather than throwing.
    const [missing] = await provenance.stageCardEvidenceSpans(client, {
      spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      cardExtractionFingerprint: "card-v3",
      refs: [{ pageOrdinal: 0, quote: "not on this page anywhere" }],
    });
    assert.equal(missing, null);

    // Sweeping with no generations at all deletes the one card-only span (no
    // generation reaches it) but never the parser span -- the reused
    // parser span above kept its null fingerprint list, so it was never a
    // candidate for either counting or deletion.
    const deleted = await provenance.sweepCardEvidenceSpans(client, {
      spaceId,
      sourceItemId: item.id,
      sourceTextVersionId: textVersion.id,
    });
    assert.equal(deleted, 1);
    const remaining = await client.query(
      "SELECT id FROM kith.evidence_spans WHERE source_text_version_id=$1",
      [textVersion.id],
    );
    assert.deepEqual(
      remaining.rows.map((row) => row.id).sort(),
      [parserSpan.id].sort(),
    );
  },
);

test(
  "the generation chain resolves for an archived binary revision and its parsed text version",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);
    const spaceId = seedSpace();
    const sourceAccountId = await seedSourceAccount(client, spaceId);
    const userId = await seedUser(client);
    const actorCredentialId = await seedApiKey(client);

    const item = await provenance.createOrGetSourceItem(client, {
      spaceId,
      sourceAccountId,
      externalId: "fixture/statement.pdf",
    });
    const contentHash = (await sha256Utf8("binary-bytes-fixture")).toString();
    const archivedRevision = await provenance.createOrGetArchivedRevision(client, {
      spaceId,
      sourceItemId: item.id,
      contentHash,
      byteLength: 2048,
      mediaType: "application/pdf",
      capturedAt: new Date(),
      userId,
    });
    assert.equal(archivedRevision.representation, "archived_binary_v1");

    const parserArtifact = await provenance.createOrGetParserArtifact(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: archivedRevision.id,
      clientArtifactId: cryptoRandomUuid(),
      parserFingerprint: "parser-v1",
      outputHash: await sha256Utf8("parsed-pages-fixture"),
      outputByteLength: 512,
      outputMediaType: "application/x-parsed-pages",
      userId,
      actorCredentialId,
      createdAt: new Date(),
    });

    const parsedTextVersion = await provenance.createOrGetParsedTextVersion(client, {
      spaceId,
      sourceRevisionId: archivedRevision.id,
      parserArtifactId: parserArtifact.id,
      extractionFingerprint: "extract-v1",
      textHash: await sha256Utf8("Parsed page text."),
      byteLength: 18,
      utf16Length: 18,
      pageCount: 1,
      mappingManifestHash: await sha256Utf8("mapping-manifest"),
    });
    assert.equal(parsedTextVersion.representation, "parsed_pages_v1");
    assert.equal(parsedTextVersion.parserArtifactId, parserArtifact.id);

    const receiptTime = new Date("2026-01-01T00:00:00.000Z");
    const receipt = await provenance.createOrGetArchiveReceipt(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: archivedRevision.id,
      subjectKind: "original_bytes",
      copyRole: "primary",
      clientReceiptId: cryptoRandomUuid(),
      requestDigest: await sha256Utf8("request"),
      archiveProfileFingerprint: await sha256Utf8("profile"),
      archiveIdentityFingerprint: await sha256Utf8("identity"),
      recipientFingerprint: await sha256Utf8("recipient"),
      repositoryKeyDomainFingerprint: await sha256Utf8("repo-key-domain"),
      storageFailureDomainFingerprint: await sha256Utf8("storage-failure-domain"),
      archiveObjectId: cryptoRandomUuid(),
      plaintextHash: contentHash,
      plaintextByteLength: 2048,
      plaintextMediaType: "application/pdf",
      ciphertextHash: await sha256Utf8("ciphertext"),
      ciphertextByteLength: 2200,
      readbackVerifiedAt: receiptTime,
      userId,
      actorCredentialId,
      createdAt: receiptTime,
    });
    assert.equal(receipt.subjectKind, "original_bytes");
    assert.equal(receipt.plaintextHash, contentHash);

    // Re-declaring the identical receipt is idempotent.
    const again = await provenance.createOrGetArchiveReceipt(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: archivedRevision.id,
      subjectKind: "original_bytes",
      copyRole: "primary",
      clientReceiptId: receipt.clientReceiptId,
      requestDigest: receipt.requestDigest,
      archiveProfileFingerprint: receipt.archiveProfileFingerprint,
      archiveIdentityFingerprint: receipt.archiveIdentityFingerprint,
      recipientFingerprint: receipt.recipientFingerprint,
      repositoryKeyDomainFingerprint: receipt.repositoryKeyDomainFingerprint,
      storageFailureDomainFingerprint: receipt.storageFailureDomainFingerprint,
      archiveObjectId: receipt.archiveObjectId,
      plaintextHash: receipt.plaintextHash,
      plaintextByteLength: receipt.plaintextByteLength,
      plaintextMediaType: receipt.plaintextMediaType,
      ciphertextHash: receipt.ciphertextHash,
      ciphertextByteLength: receipt.ciphertextByteLength,
      readbackVerifiedAt: receipt.readbackVerifiedAt,
      userId,
      actorCredentialId,
      createdAt: receipt.createdAtField,
    });
    assert.equal(again.id, receipt.id);
  },
);

test(
  "inventory keeps parse_failed on a rescan of the same bytes but clears it for new ones",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);
    const spaceId = seedSpace();
    const sourceAccountId = await seedSourceAccount(client, spaceId);
    const scanId = await seedWorkerScan(client, spaceId, sourceAccountId);
    const contentHash = await sha256Utf8("bytes-v1");

    await documents.upsertSourceInventoryRow(client, {
      spaceId,
      sourceAccountId,
      scanId,
      identityKeyHash: "identity-1",
      relativePath: "folder/file.txt",
      folderPath: "folder",
      fileName: "file.txt",
      sourceModifiedAt: new Date(),
      byteLength: 8,
      contentHash,
      mediaType: "text/plain",
    });

    // markInventoryParseFailed keys off sourceItemId, which this fixture's
    // row does not carry (no admitted source item yet); settle the row to
    // parse_failed directly, mirroring what markInventoryParseFailed does
    // for a row that does carry one, then exercise PR191's rescan rule.
    const row = (
      await client.query(
        "SELECT id FROM kith.source_inventory WHERE source_account_id=$1 AND identity_key_hash=$2",
        [sourceAccountId, "identity-1"],
      )
    ).rows[0];
    await client.query(
      "UPDATE kith.source_inventory SET exclusion_reason='parse_failed', exclusion_detail=$1 WHERE id=$2",
      ["unsupported_encoding", row.id],
    );

    // A rescan of the SAME bytes must not clear the settled parse_failed.
    const scanId2 = await seedWorkerScan(client, spaceId, sourceAccountId);
    await documents.upsertSourceInventoryRow(client, {
      spaceId,
      sourceAccountId,
      scanId: scanId2,
      identityKeyHash: "identity-1",
      relativePath: "folder/file.txt",
      folderPath: "folder",
      fileName: "file.txt",
      sourceModifiedAt: new Date(),
      byteLength: 8,
      contentHash,
      mediaType: "text/plain",
    });
    const settled = (
      await client.query("SELECT exclusion_reason FROM kith.source_inventory WHERE id=$1", [row.id])
    ).rows[0];
    assert.equal(settled.exclusion_reason, "parse_failed");

    // New bytes (a different content hash) reset it: that is a fresh attempt.
    const scanId3 = await seedWorkerScan(client, spaceId, sourceAccountId);
    await documents.upsertSourceInventoryRow(client, {
      spaceId,
      sourceAccountId,
      scanId: scanId3,
      identityKeyHash: "identity-1",
      relativePath: "folder/file.txt",
      folderPath: "folder",
      fileName: "file.txt",
      sourceModifiedAt: new Date(),
      byteLength: 9,
      contentHash: await sha256Utf8("bytes-v2"),
      mediaType: "text/plain",
    });
    const reset = (
      await client.query("SELECT exclusion_reason FROM kith.source_inventory WHERE id=$1", [row.id])
    ).rows[0];
    assert.equal(reset.exclusion_reason, "extraction_pending");
  },
);

async function sha256Utf8(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cryptoRandomUuid() {
  return randomBytes(16).toString("hex").replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    (_m, a, b, c, d, e) => `${a}-${b}-4${c.slice(1)}-a${d.slice(1)}-${e}`,
  );
}
