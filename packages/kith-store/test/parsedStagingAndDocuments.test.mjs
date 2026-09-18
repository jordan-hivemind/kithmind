// P2-39d2: archive bindings/deletion, provider originals, parsed staging's
// sealed-payload proof, and the documents read surface, against a real
// server. Companion to test/provenance.test.mjs (P2-39d), same fixtures and
// conventions.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { digestParsedMappingManifest } from "@repo/worker-protocol";

import { applyKithSchema, newKithId } from "../dist/index.js";
import * as provenance from "../dist/provenance/index.js";
import * as documents from "../dist/documents/index.js";

import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

function opaqueId() {
  return newKithId();
}

function seedSpace() {
  return newKithId();
}

function cryptoRandomUuid() {
  return randomBytes(16)
    .toString("hex")
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, (_m, a, b, c, d, e) => `${a}-${b}-4${c.slice(1)}-a${d.slice(1)}-${e}`);
}

async function sha256Utf8(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedSourceAccount(client, spaceId) {
  const id = opaqueId();
  await client.query("INSERT INTO kith.source_accounts (id, space_id, created_at) VALUES ($1,$2,transaction_timestamp())", [
    id,
    spaceId,
  ]);
  return id;
}

async function seedUser(client) {
  const id = opaqueId();
  await client.query("INSERT INTO kith.users (id, created_at) VALUES ($1,transaction_timestamp())", [id]);
  return id;
}

async function seedApiKey(client, userId) {
  const id = opaqueId();
  await client.query(
    `INSERT INTO kith.api_keys (id, user_id, key_hash, key_prefix, name, created_at)
     VALUES ($1,$2,$3,'test_key','Synthetic test key',transaction_timestamp())`,
    [id, userId, await sha256Utf8(id)],
  );
  return id;
}

/** A processing_generations row: ingestion's job (row e), so seeded with raw
 * SQL exactly as provenance.test.mjs's own `seedGeneration` does. */
async function seedGeneration(client, input) {
  const id = opaqueId();
  await client.query(
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, source_text_version_id,
        parser_artifact_id, desired_processing_epoch, card_generation, state,
        archive_set_digest, normalized_bundle_digest, expected_page_count,
        expected_evidence_span_count, expected_document_count, expected_chunk_count)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,false,'queued',$9,$10,$11,$12,$13,$14)`,
    [
      id,
      input.spaceId,
      input.sourceAccountId,
      input.sourceItemId,
      input.sourceRevisionId,
      input.sourceTextVersionId,
      input.parserArtifactId,
      input.desiredProcessingEpoch,
      "b".repeat(64),
      "c".repeat(64),
      input.expectedPageCount,
      input.expectedEvidenceSpanCount,
      input.expectedDocumentCount,
      input.expectedChunkCount,
    ],
  );
  return id;
}

/** ingestion's own job row (row e): only the columns parsedStaging.ts's
 * `sealParsedPayload` touches (a bare `state` UPDATE) matter here. */
async function seedIngestJob(client, spaceId, sourceAccountId, sourceItemId, sourceRevisionId, processingGenerationId) {
  const id = opaqueId();
  await client.query(
    `INSERT INTO kith.ingest_jobs
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, processing_generation_id,
        desired_processing_epoch, state, attempts)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,0,'processing',0)`,
    [id, spaceId, sourceAccountId, sourceItemId, sourceRevisionId, processingGenerationId],
  );
  return id;
}

async function seedDiscoveryWork(client, input) {
  const scanId = opaqueId();
  const pageId = opaqueId();
  const entryId = opaqueId();
  const workId = opaqueId();
  const now = new Date();
  const retireAt = new Date(now.getTime() + 60_000);
  await client.query(
    `INSERT INTO kith.worker_source_scans
     (id, space_id, created_at, source_account_id, request_id, request_digest,
      watcher_id, connector_version, mode, inventory_epoch, manifest_version_at_begin,
      actor_user_id, actor_credential_id, state, next_page_ordinal,
      next_reconcile_ordinal, inventory_done, page_count, entry_count, changed_count,
      gap_count, review_count, started_at, expires_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,'fixture-scan','fixture-digest',
      'fixture-watcher','fixture-connector','normal',0,0,$4,$5,'enumerated',
      1,1,true,1,1,1,0,0,$6,$7,$7)`,
    [scanId, input.spaceId, input.sourceAccountId, input.userId, input.credentialId, now, retireAt],
  );
  await client.query(
    `INSERT INTO kith.worker_scan_pages
     (id, space_id, created_at, source_account_id, scan_id, ordinal,
      request_id, entry_count, created_at_field, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,0,'fixture-page',1,$5,$6)`,
    [pageId, input.spaceId, input.sourceAccountId, scanId, now, retireAt],
  );
  await client.query(
    `INSERT INTO kith.worker_scan_entries
     (id, space_id, created_at, source_account_id, scan_id, scan_page_id,
      source_item_id, identity_key_hash, uri_digest, inventory_metadata_digest,
      source_modified_at, state, observed_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,'fixture-identity',
      'fixture-uri','fixture-metadata',$7,'queued',$7,$8)`,
    [entryId, input.spaceId, input.sourceAccountId, scanId, pageId, input.sourceItemId, now, retireAt],
  );
  await client.query(
    `INSERT INTO kith.worker_discovery_work
     (id, space_id, created_at, source_account_id, source_item_id, scan_id,
      scan_entry_id, observation_epoch, processing_epoch, state, content_hash,
      byte_length, captured_at, source_modified_at, media_type, profile_id,
      extraction_fingerprint, extractor_fingerprint, record_schema_fingerprint,
      normalization_fingerprint, chunker_fingerprint, uri, actor_user_id,
      actor_credential_id, attempts, lease_epoch, created_at_field, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,1,1,'admitted',$7,
      1,$8,$8,'application/pdf','fixture-profile','fixture-extraction',
      'fixture-extractor','fixture-records','fixture-normalization',
      'fixture-chunker','fixture://parsed',$9,$10,1,1,$8,$11)`,
    [workId, input.spaceId, input.sourceAccountId, input.sourceItemId, scanId, entryId,
      "a".repeat(64), now, input.userId, input.credentialId, retireAt],
  );
  await client.query(
    "UPDATE kith.worker_scan_entries SET discovery_work_id = $1 WHERE id = $2",
    [workId, entryId],
  );
  return workId;
}

/** worker_parsed_stages: row e's own table (see its module header in
 * migration 004). Seeded with the fields parsedStaging.ts's functions
 * actually read; every other column stays NULL, which the table permits. */
async function seedWorkerParsedStage(client, input) {
  const id = opaqueId();
  await client.query(
    `INSERT INTO kith.worker_parsed_stages
       (id, space_id, created_at, source_account_id, source_item_id, discovery_work_id, ingest_job_id,
        processing_generation_id, source_revision_id, source_text_version_id, parser_artifact_id,
        archive_set_digest, normalized_bundle_digest, mapping_manifest_hash, phase, next_ordinal,
        expected_page_count, expected_evidence_span_count, expected_document_count, expected_chunk_count,
        accepted_page_count, accepted_evidence_span_count, accepted_document_count, accepted_chunk_count,
        page_ids, evidence_span_ids, document_ids, chunk_ids, page_bytes, evidence_bytes, document_bytes,
        chunk_bytes, created_at_field, updated_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pages',0,
      $14,$15,$16,$17,0,0,0,0,'[]','[]','[]','[]',0,0,0,0,$18,$18,$19)`,
    [
      id,
      input.spaceId,
      input.sourceAccountId,
      input.sourceItemId,
      input.discoveryWorkId,
      input.ingestJobId,
      input.processingGenerationId,
      input.sourceRevisionId,
      input.sourceTextVersionId,
      input.parserArtifactId,
      "b".repeat(64),
      "c".repeat(64),
      input.mappingManifestHash,
      input.expectedPageCount,
      input.expectedEvidenceSpanCount,
      input.expectedDocumentCount,
      input.expectedChunkCount,
      new Date(),
      new Date(Date.now() + 60_000),
    ],
  );
  return {
    id,
    spaceId: input.spaceId,
    sourceAccountId: input.sourceAccountId,
    sourceItemId: input.sourceItemId,
    ingestJobId: input.ingestJobId,
    processingGenerationId: input.processingGenerationId,
    sourceRevisionId: input.sourceRevisionId,
    sourceTextVersionId: input.sourceTextVersionId,
    parserArtifactId: input.parserArtifactId,
    discoveryWorkId: input.discoveryWorkId,
    archiveSetDigest: "b".repeat(64),
    normalizedBundleDigest: "c".repeat(64),
    mappingManifestHash: input.mappingManifestHash,
    phase: "pages",
    nextOrdinal: 0,
    expectedPageCount: input.expectedPageCount,
    expectedEvidenceSpanCount: input.expectedEvidenceSpanCount,
    expectedDocumentCount: input.expectedDocumentCount,
    expectedChunkCount: input.expectedChunkCount,
    acceptedPageCount: 0,
    acceptedEvidenceSpanCount: 0,
    acceptedDocumentCount: 0,
    acceptedChunkCount: 0,
    pageIds: [],
    evidenceSpanIds: [],
    documentIds: [],
    chunkIds: [],
    pageBytes: 0,
    evidenceBytes: 0,
    documentBytes: 0,
    chunkBytes: 0,
  };
}

test(
  "parsed staging seals a two-span generation, verifies it, excludes a card-staged span from the manifest, and rejects a digest mismatch",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);
    const spaceId = seedSpace();
    const sourceAccountId = await seedSourceAccount(client, spaceId);
    const userId = await seedUser(client);
    const actorCredentialId = await seedApiKey(client, userId);

    const item = await provenance.createOrGetSourceItem(client, {
      spaceId,
      sourceAccountId,
      externalId: "fixture/parsed.pdf",
    });
    const archivedRevision = await provenance.createOrGetArchivedRevision(client, {
      spaceId,
      sourceItemId: item.id,
      contentHash: await sha256Utf8("binary-bytes"),
      byteLength: 1024,
      mediaType: "application/pdf",
      capturedAt: new Date(),
      userId,
    });
    const parserArtifact = await provenance.createOrGetParserArtifact(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: archivedRevision.id,
      clientArtifactId: cryptoRandomUuid(),
      parserFingerprint: "parser-v1",
      outputHash: await sha256Utf8("parsed-output"),
      outputByteLength: 256,
      outputMediaType: "application/x-parsed-pages",
      userId,
      actorCredentialId,
      createdAt: new Date(),
    });

    // One page "AB", two page-locator evidence spans ("A" and "B"), one
    // document over both spans, and one chunk per span -- the same fixture
    // shape parsedStaging.test.ts's own `requirePageChunkProfile` fixture
    // uses, so the mapping-manifest digest it computes is exactly what
    // `sealParsedPayload` must reproduce.
    const pageText = "AB";
    const pageTextHash = await sha256Utf8(pageText);
    const pageInputs = [{ ordinal: 0, start: 0, end: 2, text: pageText, textHash: pageTextHash }];
    const evidenceInputs = [
      {
        ordinal: 0,
        pageOrdinal: 0,
        start: 0,
        end: 1,
        quoteHash: await sha256Utf8("A"),
        locator: { kind: "parser_page_v1", pageNumber: 1, pageTextHash },
      },
      {
        ordinal: 1,
        pageOrdinal: 0,
        start: 1,
        end: 2,
        quoteHash: await sha256Utf8("B"),
        locator: { kind: "parser_page_v1", pageNumber: 1, pageTextHash },
      },
    ];
    const mappingManifestHash = await digestParsedMappingManifest(pageInputs, evidenceInputs);

    const parsedTextVersion = await provenance.createOrGetParsedTextVersion(client, {
      spaceId,
      sourceRevisionId: archivedRevision.id,
      parserArtifactId: parserArtifact.id,
      extractionFingerprint: "extract-v1",
      textHash: pageTextHash,
      byteLength: 2,
      utf16Length: 2,
      pageCount: 1,
      mappingManifestHash,
    });
    assert.equal(parsedTextVersion.evidenceSealed, false);

    const generationId = await seedGeneration(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: archivedRevision.id,
      sourceTextVersionId: parsedTextVersion.id,
      parserArtifactId: parserArtifact.id,
      mappingManifestHash,
      desiredProcessingEpoch: 0,
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 2,
      expectedDocumentCount: 1,
      expectedChunkCount: 2,
    });
    const ingestJobId = await seedIngestJob(client, spaceId, sourceAccountId, item.id, archivedRevision.id, generationId);
    const discoveryWorkId = await seedDiscoveryWork(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      userId,
      credentialId: actorCredentialId,
    });
    const stage = await seedWorkerParsedStage(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      discoveryWorkId,
      ingestJobId,
      processingGenerationId: generationId,
      sourceRevisionId: archivedRevision.id,
      sourceTextVersionId: parsedTextVersion.id,
      parserArtifactId: parserArtifact.id,
      mappingManifestHash,
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 2,
      expectedDocumentCount: 1,
      expectedChunkCount: 2,
    });

    const pageInsert = await provenance.insertParsedPages(client, stage, pageInputs);
    stage.pageIds = pageInsert.ids;
    stage.pageBytes = pageInsert.bytes;

    const evidenceInsert = await provenance.insertParsedEvidence(client, stage, evidenceInputs);
    stage.evidenceSpanIds = evidenceInsert.ids;
    stage.evidenceBytes = evidenceInsert.bytes;

    const documentInsert = await provenance.insertParsedDocuments(client, stage, [
      {
        documentKey: "doc-1",
        title: "Fixture document",
        docType: "note",
        capturedAt: Date.now(),
        evidence: [
          { pageOrdinal: 0, evidenceOrdinal: 0 },
          { pageOrdinal: 0, evidenceOrdinal: 1 },
        ],
      },
    ]);
    stage.documentIds = documentInsert.ids;
    stage.documentBytes = documentInsert.bytes;

    const chunkInsert = await provenance.insertParsedChunks(client, stage, [
      { documentKey: "doc-1", ordinal: 0, start: 0, end: 1, text: "A", evidence: [{ pageOrdinal: 0, evidenceOrdinal: 0 }] },
      { documentKey: "doc-1", ordinal: 1, start: 1, end: 2, text: "B", evidence: [{ pageOrdinal: 0, evidenceOrdinal: 1 }] },
    ]);
    stage.chunkIds = chunkInsert.ids;
    stage.chunkBytes = chunkInsert.bytes;

    // P2-100d. Staging still refuses a row over its own byte ceiling. The
    // ceiling is checked after the INSERT, so the attempt runs in a
    // transaction that is rolled back rather than leaving a page behind.
    const oversizePage = "z".repeat(96 * 1024 + 1);
    await client.query("BEGIN");
    await assert.rejects(
      provenance.insertParsedPages(client, stage, [
        {
          ordinal: 1,
          start: 2,
          end: 2 + oversizePage.length,
          text: oversizePage,
          textHash: await sha256Utf8(oversizePage),
        },
      ]),
      /invalid_request/,
    );
    await client.query("ROLLBACK");

    // P2-100d. Seal still requires the four byte totals it recomputes to equal
    // what staging accumulated. The check runs before the manifest is written,
    // so the refused attempt leaves nothing sealed.
    await assert.rejects(
      provenance.sealParsedPayload(client, { ...stage, pageBytes: stage.pageBytes + 1 }, new Date()),
      /scan_conflict/,
    );

    const summary = await provenance.sealParsedPayload(client, stage, new Date());
    assert.equal(summary.pageCount, 1);
    assert.equal(summary.evidenceSpanCount, 2);
    assert.equal(summary.documentCount, 1);
    assert.equal(summary.chunkCount, 2);

    // The seal flips the text version's sealed flag. (Inline text's own
    // sealed-rows-are-immutable case is exercised in provenance.test.mjs;
    // `stagePages` itself only accepts an inline representation, so it does
    // not apply to this parsed-binary fixture.)
    const sealedTextVersion = (
      await client.query("SELECT evidence_sealed FROM kith.source_text_versions WHERE id = $1", [parsedTextVersion.id])
    ).rows[0];
    assert.equal(sealedTextVersion.evidence_sealed, true);

    const generationRow = (
      await client.query("SELECT * FROM kith.processing_generations WHERE id = $1", [generationId])
    ).rows[0];
    const generation = provenance.camelizeProcessingGeneration(generationRow);
    assert.equal(generation.state, "staged");

    const verified = await provenance.verifySealedParsedPayload(client, generation);
    assert.equal(verified.actualPageCount, 1);
    assert.equal(verified.actualEvidenceSpanCount, 2);
    assert.equal(verified.actualDocumentCount, 1);
    assert.equal(verified.actualChunkCount, 2);

    // PR199: a card runner citing the whole page stages a *new* evidence
    // span (distinct from the parser's two, which exactly tile the page) --
    // it is not the parser's evidence, so it must not change what the
    // manifest counts, even though a third row now exists in
    // `evidence_spans` for this text version.
    const [cardSpanId] = await provenance.stageCardEvidenceSpans(client, {
      spaceId,
      sourceRevisionId: archivedRevision.id,
      sourceTextVersionId: parsedTextVersion.id,
      cardExtractionFingerprint: "card-v1",
      refs: [{ pageOrdinal: 0, quote: "AB" }],
    });
    assert.ok(cardSpanId);
    const spanCount = (
      await client.query("SELECT count(*)::int AS count FROM kith.evidence_spans WHERE source_text_version_id = $1", [
        parsedTextVersion.id,
      ])
    ).rows[0].count;
    assert.equal(spanCount, 3);
    const verifiedWithCardSpan = await provenance.verifySealedParsedPayload(client, generation);
    assert.equal(verifiedWithCardSpan.actualEvidenceSpanCount, 2);

    // P2-100d. A manifest whose four byte totals were measured under a
    // different row shape -- every Convex manifest the migration carried over
    // verbatim -- still verifies, because every content proof still holds.
    await client.query(
      `UPDATE kith.processing_generation_payload_manifests
          SET page_bytes = 1, evidence_bytes = 2, document_bytes = 3, chunk_bytes = 4
        WHERE id = $1`,
      [summary.manifestId],
    );
    assert.equal((await provenance.verifySealedParsedPayload(client, generation)).actualPageCount, 1);

    // P2-100d. Nor does adding a nullable column, which changes
    // `JSON.stringify(row)` for every existing row of that table.
    await client.query("ALTER TABLE kith.source_pages ADD COLUMN p2_100d_probe text");
    assert.equal((await provenance.verifySealedParsedPayload(client, generation)).actualPageCount, 1);

    // Every content proof still refuses, and still names the check it was.
    const manifestChunkDigest = (
      await client.query("SELECT chunk_digest FROM kith.processing_generation_payload_manifests WHERE id = $1", [
        summary.manifestId,
      ])
    ).rows[0].chunk_digest;
    const sql = (text, values) => () => client.query(text, values);
    const noop = () => Promise.resolve();
    const refusesWith = async (detail, apply, undo, tamperedGeneration = generation) => {
      await apply();
      const seen = [];
      await assert.rejects(
        provenance.verifySealedParsedPayload(client, tamperedGeneration, (named) => seen.push(named)),
        /scan_conflict/,
      );
      assert.deepEqual(seen, [detail]);
      await undo();
      assert.equal((await provenance.verifySealedParsedPayload(client, generation)).actualPageCount, 1);
    };
    const setManifest = (column, value) =>
      sql(`UPDATE kith.processing_generation_payload_manifests SET ${column} = $2 WHERE id = $1`, [
        summary.manifestId,
        value,
      ]);
    const [chunkA] = stage.chunkIds;
    const [spanA] = stage.evidenceSpanIds;
    await refusesWith(
      "id_sets",
      setManifest("chunk_ids", JSON.stringify([chunkA])),
      setManifest("chunk_ids", JSON.stringify(stage.chunkIds)),
    );
    await refusesWith("row_counts", noop, noop, { ...generation, expectedChunkCount: 3 });
    await refusesWith(
      "span_loop:quote_hash",
      sql("UPDATE kith.evidence_spans SET quote_hash = $2 WHERE id = $1", [spanA, await sha256Utf8("X")]),
      sql("UPDATE kith.evidence_spans SET quote_hash = $2 WHERE id = $1", [spanA, await sha256Utf8("A")]),
    );
    await refusesWith(
      "chunk_loop:text",
      sql("UPDATE kith.chunks SET text = 'X' WHERE id = $1", [chunkA]),
      sql("UPDATE kith.chunks SET text = 'A' WHERE id = $1", [chunkA]),
    );
    await refusesWith(
      "chunk_digest",
      setManifest("chunk_digest", await sha256Utf8("not-the-chunk-digest")),
      setManifest("chunk_digest", manifestChunkDigest),
    );

    // Tampering with a sealed page's retained text is caught: the digest the
    // manifest recorded no longer reproduces.
    await client.query("UPDATE kith.source_pages SET text = 'AX' WHERE id = $1", [stage.pageIds[0]]);
    const sawPageTamper = [];
    await assert.rejects(
      provenance.verifySealedParsedPayload(client, generation, (named) => sawPageTamper.push(named)),
      /scan_conflict/,
    );
    assert.deepEqual(sawPageTamper, ["page_loop:hash"]);
  },
);

test(
  "archive bindings and deletion acknowledgements match a receipt field for field, and reject a forget-epoch mismatch",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);
    const spaceId = seedSpace();
    const sourceAccountId = await seedSourceAccount(client, spaceId);
    const userId = await seedUser(client);
    const actorCredentialId = await seedApiKey(client, userId);

    const item = await provenance.createOrGetSourceItem(client, { spaceId, sourceAccountId, externalId: "fixture/archived.bin" });
    const revision = await provenance.createOrGetArchivedRevision(client, {
      spaceId,
      sourceItemId: item.id,
      contentHash: await sha256Utf8("archive-fixture-bytes"),
      byteLength: 4096,
      mediaType: "application/pdf",
      capturedAt: new Date(),
      userId,
    });
    // One instant for creation and readback. Two `new Date()` calls can
    // straddle a millisecond boundary, and a readback earlier than creation is
    // exactly what the receipt code refuses.
    const receiptAt = new Date();
    const receipt = await provenance.createOrGetArchiveReceipt(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      subjectKind: "original_bytes",
      copyRole: "primary",
      clientReceiptId: cryptoRandomUuid(),
      requestDigest: await sha256Utf8("request"),
      archiveProfileFingerprint: await sha256Utf8("profile"),
      archiveIdentityFingerprint: await sha256Utf8("identity"),
      recipientFingerprint: await sha256Utf8("recipient"),
      repositoryKeyDomainFingerprint: await sha256Utf8("repo-key"),
      storageFailureDomainFingerprint: await sha256Utf8("storage-failure"),
      archiveObjectId: cryptoRandomUuid(),
      plaintextHash: revision.contentHash,
      plaintextByteLength: 4096,
      plaintextMediaType: "application/pdf",
      ciphertextHash: await sha256Utf8("ciphertext"),
      ciphertextByteLength: 4200,
      readbackVerifiedAt: receiptAt,
      userId,
      actorCredentialId,
      createdAt: receiptAt,
    });

    const binding = await provenance.bindInitialArchiveReceipt(client, {
      receipt,
      userId,
      actorCredentialId,
      now: new Date(),
    });
    assert.equal(binding.bindingEpoch, 0);
    assert.equal(binding.receiptId, receipt.id);

    // Rebinding the identical receipt is idempotent.
    const again = await provenance.bindInitialArchiveReceipt(client, {
      receipt,
      expectedBindingEpoch: 0,
      userId,
      actorCredentialId,
      now: new Date(),
    });
    assert.equal(again.id, binding.id);

    const current = await provenance.loadCurrentArchiveBinding(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      subjectKind: "original_bytes",
      copyRole: "primary",
    });
    assert.equal(current.receipt.id, receipt.id);

    // requireIndependentArchivePair rejects a "backup" that is really the
    // same archive object under another name.
    assert.throws(() => provenance.requireIndependentArchivePair(receipt, receipt), /independently identified/);

    // A deletion acknowledgement that names the wrong forget epoch is
    // incoherent even though every other field matches.
    const forgotten = await provenance.beginSourceItemForget(client, {
      spaceId,
      sourceItemId: item.id,
      forgottenAt: new Date(),
      forgottenBy: userId,
    });
    const itemRow = (await client.query("SELECT * FROM kith.source_items WHERE id = $1", [item.id])).rows[0];
    const ackId = opaqueId();
    async function insertAck(forgetEpoch) {
      await client.query(
        `INSERT INTO kith.source_artifact_deletion_acks
           (id, space_id, created_at, source_account_id, source_item_id, receipt_id, forget_epoch, deletion_id,
            request_id, request_digest, ack_version, absence_authority, retention_disclosure, client_receipt_id,
            receipt_request_digest, source_revision_id, parser_artifact_id, subject_kind, copy_role, receipt_version,
            archive_representation, archive_profile_fingerprint, archive_identity_fingerprint, recipient_fingerprint,
            repository_key_domain_fingerprint, storage_failure_domain_fingerprint, archive_object_id, plaintext_hash,
            plaintext_byte_length, plaintext_media_type, hash_authority, ciphertext_hash, ciphertext_byte_length,
            verification_kind, readback_verified_at, receipt_user_id, receipt_actor_credential_id, receipt_created_at,
            object_outcome, backup_outcome, actor_user_id, actor_credential_id, completed_at)
         VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,'archive_deletion_ack_v1','worker_asserted_physical_absence',
                 NULL,$10,$11,$12,$13,$14,$15,$16,'age_encrypted_v1',$17,$18,$19,$20,$21,$22,$23,$24,$25,'worker_asserted',$26,$27,
                 'ciphertext_readback_sha256',$28,$29,$30,$31,'deleted',NULL,$29,$30,transaction_timestamp())
         ON CONFLICT (id) DO UPDATE SET forget_epoch = EXCLUDED.forget_epoch`,
        [
          ackId,
          spaceId,
          sourceAccountId,
          item.id,
          receipt.id,
          forgetEpoch,
          cryptoRandomUuid(),
          cryptoRandomUuid(),
          await sha256Utf8("deletion-request"),
          receipt.clientReceiptId,
          receipt.requestDigest,
          revision.id,
          null,
          receipt.subjectKind,
          receipt.copyRole,
          receipt.receiptVersion,
          receipt.archiveProfileFingerprint,
          receipt.archiveIdentityFingerprint,
          receipt.recipientFingerprint,
          receipt.repositoryKeyDomainFingerprint,
          receipt.storageFailureDomainFingerprint,
          receipt.archiveObjectId,
          receipt.plaintextHash,
          receipt.plaintextByteLength,
          receipt.plaintextMediaType,
          receipt.ciphertextHash,
          receipt.ciphertextByteLength,
          receipt.readbackVerifiedAt,
          receipt.userId,
          receipt.actorCredentialId,
          receipt.createdAtField,
        ],
      );
    }
    await insertAck(forgotten);
    const item2 = provenance.camelizeSourceItem(itemRow);
    const ack = await provenance.loadArchiveDeletionAck(client, receipt, item2, forgotten);
    assert.ok(ack);
    assert.equal(ack.forgetEpoch, forgotten);

    // The same ack row, looked up under a forget epoch it does not name,
    // simply is not found -- `forget_epoch` is part of its identity.
    const noAck = await provenance.loadArchiveDeletionAck(client, receipt, item2, forgotten + 1);
    assert.equal(noAck, null);
  },
);

test("provider original references bind, rebind on a newer verification, and reject a stale declaration", { skip }, async (t) => {
  const client = await connect(await throwawayDatabase(t));
  await applyKithSchema(client);
  const spaceId = seedSpace();
  const sourceAccountId = await seedSourceAccount(client, spaceId);
  const userId = await seedUser(client);
  const actorCredentialId = await seedApiKey(client, userId);
  const item = await provenance.createOrGetSourceItem(client, { spaceId, sourceAccountId, externalId: "fixture/dropbox.bin" });
  const revision = await provenance.createOrGetArchivedRevision(client, {
    spaceId,
    sourceItemId: item.id,
    contentHash: await sha256Utf8("provider-fixture-bytes"),
    byteLength: 2048,
    mediaType: "application/pdf",
    capturedAt: new Date(),
    userId,
  });

  function declaration(overrides = {}) {
    const now = Date.now();
    return {
      referenceVersion: "provider_original_v1",
      providerKind: "dropbox_v1",
      clientReferenceId: cryptoRandomUuid(),
      sourceContentHash: "a".repeat(64),
      sourceByteLength: 2048,
      providerAccountIdHash: "b".repeat(64),
      providerRootDirectoryIdHash: "c".repeat(64),
      providerFileIdHash: "d".repeat(64),
      providerRevision: "rev-1",
      providerContentHash: "e".repeat(64),
      verifiedAt: now,
      locatorBundle: {
        bindingId: cryptoRandomUuid(),
        manifestFingerprint: "f".repeat(64),
        recipientFingerprint: "0".repeat(64),
        repositoryKeyDomainFingerprint: "1".repeat(64),
        repositoryId: "3".repeat(64),
        snapshotId: "4".repeat(64),
        objectName: "object-1",
        ciphertextHash: "2".repeat(64),
        ciphertextByteLength: 2200,
        readbackVerifiedAt: now,
      },
      createdAt: now,
      ...overrides,
    };
  }

  const first = declaration();
  const { reference, binding } = await provenance.createAndBindProviderOriginal(client, {
    spaceId,
    sourceAccountId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    declaration: first,
    requestDigest: await sha256Utf8("request-1"),
    userId,
    actorCredentialId,
    now: new Date(),
  });
  assert.equal(binding.bindingEpoch, 0);
  assert.equal(binding.referenceId, reference.id);

  const loaded = await provenance.loadProviderOriginalBinding(client, revision.id);
  assert.equal(loaded.binding.id, binding.id);
  assert.equal(loaded.reference.id, reference.id);

  // A later, newer verification of the same provider identity rebinds and
  // advances the fence.
  const later = declaration({
    clientReferenceId: cryptoRandomUuid(),
    verifiedAt: first.verifiedAt + 1_000,
    locatorBundle: { ...first.locatorBundle, readbackVerifiedAt: first.verifiedAt + 1_000 },
  });
  const rebound = await provenance.createAndBindProviderOriginal(client, {
    spaceId,
    sourceAccountId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    declaration: later,
    requestDigest: await sha256Utf8("request-2"),
    userId,
    actorCredentialId,
    now: new Date(),
  });
  assert.equal(rebound.binding.bindingEpoch, 1);
  assert.equal(rebound.binding.referenceId, rebound.reference.id);
  assert.notEqual(rebound.reference.id, reference.id);

  // A declaration verified further in the past than the staleness window
  // allows is rejected outright.
  const stale = declaration({
    clientReferenceId: cryptoRandomUuid(),
    verifiedAt: Date.now() - 60 * 60 * 1_000,
  });
  await assert.rejects(
    provenance.createAndBindProviderOriginal(client, {
      spaceId,
      sourceAccountId,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      declaration: stale,
      requestDigest: await sha256Utf8("request-3"),
      userId,
      actorCredentialId,
      now: new Date(),
    }),
    /stale/,
  );
});

test("getDocument and searchDocuments overlay the item's live card doc type onto an active document", { skip }, async (t) => {
  const client = await connect(await throwawayDatabase(t));
  await applyKithSchema(client);
  const spaceId = seedSpace();
  const sourceAccountId = await seedSourceAccount(client, spaceId);
  const userId = await seedUser(client);
  const text = "The quarterly statement total is settled.";

  const item = await provenance.createOrGetSourceItem(client, {
    spaceId,
    sourceAccountId,
    externalId: "fixture/read-surface.txt",
    title: "Read surface fixture",
  });
  const revision = await provenance.createOrGetRevision(client, {
    spaceId,
    sourceItemId: item.id,
    mediaType: "text/plain",
    inlineText: text,
    capturedAt: new Date("2026-02-01T00:00:00Z"),
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
  const [span] = await provenance.stageEvidenceSpans(client, {
    spaceId,
    sourceRevisionId: revision.id,
    sourceTextVersionId: textVersion.id,
    spans: [{ sourcePageId: page.id, ordinal: 0, start: 4, end: 13 }],
  });
  await provenance.setDesiredSourceRevision(client, {
    spaceId,
    sourceItemId: item.id,
    desiredRevisionId: revision.id,
    expectedDesiredProcessingEpoch: 0,
  });
  const generationId = (
    await client.query(
      `INSERT INTO kith.processing_generations
         (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, source_text_version_id,
          desired_processing_epoch, card_generation, state)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,1,false,'queued') RETURNING id`,
      [opaqueId(), spaceId, sourceAccountId, item.id, revision.id, textVersion.id],
    )
  ).rows[0].id;
  const [document] = await provenance.stageDocuments(client, {
    spaceId,
    processingGenerationId: generationId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    sourceTextVersionId: textVersion.id,
    documents: [
      {
        documentKey: "doc-1",
        title: "Quarterly statement",
        docType: "statement",
        capturedAt: new Date("2026-02-01T00:00:00Z"),
        evidenceSpanIds: [span.id],
      },
    ],
  });
  await provenance.stageChunks(client, {
    spaceId,
    processingGenerationId: generationId,
    chunks: [{ documentId: document.id, ordinal: 0, text, evidenceSpanIds: [span.id] }],
  });
  await provenance.activateSourceItemGeneration(client, {
    spaceId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    processingGenerationId: generationId,
    expectedDesiredProcessingEpoch: 1,
  });
  // Ingestion's own activation step (row e) also flips the generation to
  // "ready" with an activation timestamp; not ported here, so seeded
  // directly, exactly as `seedGeneration` stands in for row e elsewhere.
  await client.query("UPDATE kith.processing_generations SET state = 'ready', activated_at = transaction_timestamp() WHERE id = $1", [
    generationId,
  ]);

  const before = await documents.getDocument(client, [spaceId], document.id);
  assert.equal(before.docType, "statement");
  assert.equal(before.title, "Quarterly statement");
  assert.equal(before.contentStatus, "ready");

  // Direct-ID reads and keyword discovery both honor the caller-derived
  // authorized space list. The low-level surface cannot authorize itself,
  // but it must never make a forged broader list unnecessary.
  const foreignSpaceId = seedSpace();
  assert.equal(await documents.getDocument(client, [foreignSpaceId], document.id), null);
  assert.deepEqual(
    (await documents.searchDocuments(client, [foreignSpaceId], { query: "quarterly" })).results,
    [],
  );

  const searchBefore = await documents.searchDocuments(client, [spaceId], { query: "quarterly" });
  assert.equal(searchBefore.results.length, 1);
  assert.equal(searchBefore.results[0].docType, "statement");
  assert.equal(searchBefore.results[0].documentId, document.id);

  // P2-80i: a live card's kind overlays the parser's own docType on an
  // active document, without touching the sealed `documents` row.
  await client.query("UPDATE kith.source_items SET card_doc_type = $1 WHERE id = $2", ["invoice", item.id]);

  const after = await documents.getDocument(client, [spaceId], document.id);
  assert.equal(after.docType, "invoice");
  assert.deepEqual(JSON.parse(JSON.stringify(after)), {
    ...JSON.parse(JSON.stringify(before)),
    docType: "invoice",
  });
  const documentRow = (await client.query("SELECT doc_type FROM kith.documents WHERE id = $1", [document.id])).rows[0];
  assert.equal(documentRow.doc_type, "statement", "the sealed document row itself is untouched");

  const searchAfter = await documents.searchDocuments(client, [spaceId], { query: "quarterly", docType: "invoice" });
  assert.equal(searchAfter.results.length, 1);
  assert.equal(searchAfter.results[0].docType, "invoice");
  assert.equal(
    JSON.parse(JSON.stringify(searchAfter.results[0])).capturedAt,
    "2026-02-01T00:00:00.000Z",
  );

  const filteredOut = await documents.searchDocuments(client, [spaceId], { query: "quarterly", docType: "statement" });
  assert.equal(filteredOut.results.length, 0);

  // A real, stored span from a different revision cannot become a citation:
  // it is not in this document's revision/text chain, so the read reports
  // partial content and withholds the pointer rather than returning a
  // cross-chain quote.
  const foreignItem = await provenance.createOrGetSourceItem(client, {
    spaceId,
    sourceAccountId,
    externalId: "fixture/foreign-citation.txt",
  });
  const foreignRevision = await provenance.createOrGetRevision(client, {
    spaceId,
    sourceItemId: foreignItem.id,
    mediaType: "text/plain",
    inlineText: "Foreign citation text.",
    capturedAt: new Date("2026-02-02T00:00:00Z"),
    userId,
  });
  const foreignText = await provenance.createOrGetTextVersion(client, {
    spaceId,
    sourceRevisionId: foreignRevision.id,
    extractionFingerprint: "foreign-extract-v1",
    text: "Foreign citation text.",
  });
  const [foreignPage] = await provenance.stagePages(client, {
    spaceId,
    sourceTextVersionId: foreignText.id,
    pages: [{ ordinal: 0, start: 0, end: foreignText.text.length, text: foreignText.text }],
  });
  const [foreignSpan] = await provenance.stageEvidenceSpans(client, {
    spaceId,
    sourceRevisionId: foreignRevision.id,
    sourceTextVersionId: foreignText.id,
    spans: [{ sourcePageId: foreignPage.id, ordinal: 0, start: 0, end: 7 }],
  });
  await client.query("UPDATE kith.documents SET evidence_span_ids = $1::jsonb WHERE id = $2", [JSON.stringify([foreignSpan.id]), document.id]);
  const forgedCitation = await documents.getDocument(client, [spaceId], document.id);
  assert.ok(forgedCitation);
  assert.deepEqual(forgedCitation.evidenceSpanIds, []);
  assert.equal(forgedCitation.partial, true);

  // An active document disappears from ordinary reads when its generation is
  // superseded, while an explicit historical read remains available and says
  // so. This is the source/document lifecycle boundary the read API exposes.
  await client.query("UPDATE kith.documents SET publication_state = 'historical' WHERE id = $1", [document.id]);
  await client.query("UPDATE kith.chunks SET publication_state = 'historical' WHERE document_id = $1", [document.id]);
  await client.query("UPDATE kith.processing_generations SET deactivated_at = transaction_timestamp() WHERE id = $1", [generationId]);
  assert.equal(await documents.getDocument(client, [spaceId], document.id), null);
  const historical = await documents.getDocument(client, [spaceId], document.id, true);
  assert.ok(historical);
  assert.equal(historical.historical, true);
  assert.equal(historical.contentStatus, "historical");
});

// P2-39g4. The document keyword leg has no frozen public corpus the way the
// memory legs do (`test/recallParity.test.mjs` over `src/eval/corpus.ts`), so
// the behavior the shared construction in `src/textSearch.ts` restores is
// proved here directly, on chunks seeded through the real provenance chain.
//
// Two things, both of which the previous `websearch_to_tsquery` leg got wrong
// or could not express:
//
//   1. A query carrying one ordinary word the chunk does not contain still
//      finds the chunk. Under AND-of-terms one absent word dropped the row
//      outright, which is the regression the recall instrument measured at
//      0.167 on the memory corpus (docs/retrieval-parity-postgres.md).
//   2. Ranking prefers the chunk matching more of the query's terms, so
//      broadening the match does not flatten the ordering into arbitrary.
test("the document keyword leg matches partial term overlap and ranks by how much matched", { skip }, async (t) => {
  const client = await connect(await throwawayDatabase(t));
  await applyKithSchema(client);
  const spaceId = seedSpace();
  const sourceAccountId = await seedSourceAccount(client, spaceId);
  const userId = await seedUser(client);

  // "broad" carries three of the query's four significant terms; "narrow"
  // carries one. Neither contains "overdue", the ordinary word that used to
  // drop both rows on its own.
  const broad = "The quarterly invoice reconciliation was approved by finance.";
  const narrow = "A reconciliation meeting is on the calendar for spring.";
  const text = `${broad}\n${narrow}`;

  const item = await provenance.createOrGetSourceItem(client, {
    spaceId,
    sourceAccountId,
    externalId: "fixture/keyword-overlap.txt",
    title: "Keyword overlap fixture",
  });
  const revision = await provenance.createOrGetRevision(client, {
    spaceId,
    sourceItemId: item.id,
    mediaType: "text/plain",
    inlineText: text,
    capturedAt: new Date("2026-03-01T00:00:00Z"),
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
  const spans = await provenance.stageEvidenceSpans(client, {
    spaceId,
    sourceRevisionId: revision.id,
    sourceTextVersionId: textVersion.id,
    spans: [
      { sourcePageId: page.id, ordinal: 0, start: 0, end: broad.length },
      { sourcePageId: page.id, ordinal: 1, start: broad.length + 1, end: text.length },
    ],
  });
  await provenance.setDesiredSourceRevision(client, {
    spaceId,
    sourceItemId: item.id,
    desiredRevisionId: revision.id,
    expectedDesiredProcessingEpoch: 0,
  });
  const generationId = (
    await client.query(
      `INSERT INTO kith.processing_generations
         (id, space_id, created_at, source_account_id, source_item_id, source_revision_id, source_text_version_id,
          desired_processing_epoch, card_generation, state)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,1,false,'queued') RETURNING id`,
      [opaqueId(), spaceId, sourceAccountId, item.id, revision.id, textVersion.id],
    )
  ).rows[0].id;
  // One document per chunk, so the ranking this test is about is visible in
  // the result order the caller actually sees rather than buried in citations.
  const [broadDocument, narrowDocument] = await provenance.stageDocuments(client, {
    spaceId,
    processingGenerationId: generationId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    sourceTextVersionId: textVersion.id,
    documents: [
      {
        documentKey: "doc-broad",
        title: "Quarterly reconciliation",
        docType: "statement",
        capturedAt: new Date("2026-03-01T00:00:00Z"),
        evidenceSpanIds: [spans[0].id],
      },
      {
        documentKey: "doc-narrow",
        title: "Reconciliation meeting",
        docType: "statement",
        capturedAt: new Date("2026-03-01T00:00:00Z"),
        evidenceSpanIds: [spans[1].id],
      },
    ],
  });
  await provenance.stageChunks(client, {
    spaceId,
    processingGenerationId: generationId,
    chunks: [
      { documentId: broadDocument.id, ordinal: 0, text: broad, evidenceSpanIds: [spans[0].id] },
      { documentId: narrowDocument.id, ordinal: 0, text: narrow, evidenceSpanIds: [spans[1].id] },
    ],
  });
  await provenance.activateSourceItemGeneration(client, {
    spaceId,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    processingGenerationId: generationId,
    expectedDesiredProcessingEpoch: 1,
  });
  await client.query("UPDATE kith.processing_generations SET state = 'ready', activated_at = transaction_timestamp() WHERE id = $1", [
    generationId,
  ]);

  // "overdue" appears in neither chunk, and "quarterly", "invoice" and
  // "reconciliation" appear only in `broad`. Under AND-of-terms this returned
  // nothing at all, because of the one word neither chunk contains.
  const overlap = await documents.searchDocuments(client, [spaceId], {
    query: "overdue quarterly invoice reconciliation",
  });
  const rankedIds = overlap.results.map((result) => result.documentId);
  assert.ok(
    rankedIds.includes(broadDocument.id),
    `a query with one absent ordinary word must still find the chunk, got ${JSON.stringify(rankedIds)}`,
  );
  assert.equal(
    rankedIds[0],
    broadDocument.id,
    `the chunk matching three query terms must rank above the chunk matching one, got ${JSON.stringify(rankedIds)}`,
  );
  assert.ok(
    rankedIds.includes(narrowDocument.id),
    "the single-term chunk is still a candidate, just a lower ranked one",
  );

  // A query sharing no term with either chunk still returns nothing. The
  // broadened match is an OR over the query's own lexemes, not a match-all.
  const unrelated = await documents.searchDocuments(client, [spaceId], {
    query: "hydroponic greenhouse irrigation",
  });
  assert.deepEqual(unrelated.results, []);

  // Broadening the match does not widen the space boundary.
  const foreign = await documents.searchDocuments(client, [seedSpace()], {
    query: "overdue quarterly invoice reconciliation",
  });
  assert.deepEqual(foreign.results, []);
});
