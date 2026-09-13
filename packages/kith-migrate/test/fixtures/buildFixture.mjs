import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const T0 = 1893456000000; // 2030-01-01T00:00:00Z, an arbitrary fixed instant.
const DAY = 86_400_000;

const ROWAN_TEXT = "Invoice number 001 for the kitchen renovation. Total due: 4200.00 USD.";
const SAGE_TEXT = "Garden notes: plant tomatoes in May and basil in June.";
const ROWAN_QUOTE = "Invoice number 001";
const SAGE_QUOTE = "Garden notes:";

/**
 * A small, synthetic, two-space Convex corpus: invented people (Rowan and
 * Sage, no real names), one document per space, one thought, one fact, and
 * one financial-transaction-shaped event/observation, plus a drained
 * (`inlineWork`) row to prove the "not migrated" tables load as zero rows
 * even when the export itself still holds one.
 *
 * Returns the plain per-table row map (what `documents.jsonl` holds, one
 * table per key) plus a few ids the tests assert against directly.
 */
export function syntheticConvexTables() {
  const tables = {
    users: [
      { _id: "usr_rowan", _creationTime: T0, name: "Rowan Vale", email: "rowan@example.test" },
      { _id: "usr_sage", _creationTime: T0, name: "Sage Vale", email: "sage@example.test" },
    ],
    authAccounts: [
      {
        _id: "aac_rowan_pw",
        _creationTime: T0,
        userId: "usr_rowan",
        type: "credentials",
        provider: "password",
        providerAccountId: "rowan@example.test",
        secret: "scrypt:synthetic-secret",
      },
    ],
    spaces: [
      { _id: "spc_rowan", _creationTime: T0, kind: "shared", name: "Rowan household", createdBy: "usr_rowan" },
      { _id: "spc_sage", _creationTime: T0, kind: "personal", name: "Sage household", createdBy: "usr_sage" },
    ],
    spaceMembers: [
      { _id: "mem_rowan_owner", _creationTime: T0, spaceId: "spc_rowan", userId: "usr_rowan", role: "owner" },
      { _id: "mem_sage_owner", _creationTime: T0, spaceId: "spc_sage", userId: "usr_sage", role: "owner" },
    ],
    userSpaceSettings: [
      { _id: "uss_rowan", _creationTime: T0, userId: "usr_rowan", personalSpaceId: "spc_rowan" },
      { _id: "uss_sage", _creationTime: T0, userId: "usr_sage", personalSpaceId: "spc_sage" },
    ],
    apiKeys: [
      {
        _id: "key_rowan",
        _creationTime: T0,
        userId: "usr_rowan",
        keyHash: sha256("synthetic-api-key"),
        keyPrefix: "km_abcd",
        name: "rowan-mcp",
        capabilities: ["read", "write"],
        spaceIds: ["spc_rowan"],
        sourceAccountIds: ["acc_rowan_docs"],
      },
    ],
    sourceAccounts: [
      {
        _id: "acc_rowan_docs",
        _creationTime: T0,
        spaceId: "spc_rowan",
        connector: "local_folder",
        accountId: "rowan-docs",
        name: "Rowan Documents",
        enabled: true,
        cursorVersion: 1,
        freshnessMs: 60_000,
        createdBy: "usr_rowan",
      },
      {
        _id: "acc_sage_docs",
        _creationTime: T0,
        spaceId: "spc_sage",
        connector: "local_folder",
        accountId: "sage-docs",
        name: "Sage Documents",
        enabled: true,
        cursorVersion: 1,
        freshnessMs: 60_000,
        createdBy: "usr_sage",
      },
    ],
    sourceItems: [
      {
        _id: "itm_rowan_invoice",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        externalIdHash: sha256("invoice-001"),
        externalId: "invoice-001",
        title: "Kitchen renovation invoice",
        docType: "invoice",
        uri: "file:///rowan/invoice-001.pdf",
        lifecycle: "available",
        originalLinkAvailable: true,
        desiredProcessingEpoch: 1,
      },
      {
        _id: "itm_sage_note",
        _creationTime: T0,
        spaceId: "spc_sage",
        sourceAccountId: "acc_sage_docs",
        externalIdHash: sha256("note-001"),
        externalId: "note-001",
        title: "Garden notes",
        docType: "note",
        uri: "file:///sage/note-001.txt",
        lifecycle: "available",
        originalLinkAvailable: true,
        desiredProcessingEpoch: 1,
      },
    ],
    sourceRevisions: [
      {
        _id: "rev_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceItemId: "itm_rowan_invoice",
        contentHash: sha256("rowan-invoice-bytes"),
        byteLength: 2048,
        mediaType: "application/pdf",
        capturedAt: T0,
        userId: "usr_rowan",
      },
      {
        _id: "rev_sage_1",
        _creationTime: T0,
        spaceId: "spc_sage",
        sourceItemId: "itm_sage_note",
        contentHash: sha256("sage-note-bytes"),
        byteLength: 512,
        mediaType: "text/plain",
        capturedAt: T0,
        userId: "usr_sage",
      },
    ],
    sourceTextVersions: [
      {
        _id: "txv_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceRevisionId: "rev_rowan_1",
        extractionFingerprint: "fp1",
        text: ROWAN_TEXT,
        textHash: sha256(ROWAN_TEXT),
        byteLength: Buffer.byteLength(ROWAN_TEXT, "utf8"),
        evidenceSealed: true,
      },
      {
        _id: "txv_sage_1",
        _creationTime: T0,
        spaceId: "spc_sage",
        sourceRevisionId: "rev_sage_1",
        extractionFingerprint: "fp1",
        text: SAGE_TEXT,
        textHash: sha256(SAGE_TEXT),
        byteLength: Buffer.byteLength(SAGE_TEXT, "utf8"),
        evidenceSealed: true,
      },
    ],
    sourcePages: [
      {
        _id: "pag_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceTextVersionId: "txv_rowan_1",
        ordinal: 1,
        start: 0,
        end: ROWAN_TEXT.length,
        text: ROWAN_TEXT,
        textHash: sha256(ROWAN_TEXT),
      },
      {
        _id: "pag_sage_1",
        _creationTime: T0,
        spaceId: "spc_sage",
        sourceTextVersionId: "txv_sage_1",
        ordinal: 1,
        start: 0,
        end: SAGE_TEXT.length,
        text: SAGE_TEXT,
        textHash: sha256(SAGE_TEXT),
      },
    ],
    evidenceSpans: [
      {
        _id: "spn_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceRevisionId: "rev_rowan_1",
        sourceTextVersionId: "txv_rowan_1",
        sourcePageId: "pag_rowan_1",
        ordinal: 0,
        start: 0,
        end: ROWAN_QUOTE.length,
        quoteHash: sha256(ROWAN_QUOTE),
      },
      {
        _id: "spn_sage_1",
        _creationTime: T0,
        spaceId: "spc_sage",
        sourceRevisionId: "rev_sage_1",
        sourceTextVersionId: "txv_sage_1",
        sourcePageId: "pag_sage_1",
        ordinal: 0,
        start: 0,
        end: SAGE_QUOTE.length,
        quoteHash: sha256(SAGE_QUOTE),
      },
    ],
    processingGenerations: [
      {
        _id: "gen_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        sourceItemId: "itm_rowan_invoice",
        sourceRevisionId: "rev_rowan_1",
        sourceTextVersionId: "txv_rowan_1",
        processingFingerprint: "pf1",
        extractionFingerprint: "fp1",
        extractorFingerprint: "ef1",
        recordSchemaFingerprint: "rf1",
        normalizationFingerprint: "nf1",
        chunkerFingerprint: "cf1",
        correctionRevision: "r0",
        desiredProcessingEpoch: 1,
        state: "ready",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
        embeddingStatus: "pending",
        activatedAt: T0,
      },
      {
        _id: "gen_sage_1",
        _creationTime: T0,
        spaceId: "spc_sage",
        sourceAccountId: "acc_sage_docs",
        sourceItemId: "itm_sage_note",
        sourceRevisionId: "rev_sage_1",
        sourceTextVersionId: "txv_sage_1",
        processingFingerprint: "pf1",
        extractionFingerprint: "fp1",
        extractorFingerprint: "ef1",
        recordSchemaFingerprint: "rf1",
        normalizationFingerprint: "nf1",
        chunkerFingerprint: "cf1",
        correctionRevision: "r0",
        desiredProcessingEpoch: 1,
        state: "ready",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
        embeddingStatus: "pending",
        activatedAt: T0,
      },
    ],
    documents: [
      {
        _id: "doc_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        processingGenerationId: "gen_rowan_1",
        sourceItemId: "itm_rowan_invoice",
        sourceRevisionId: "rev_rowan_1",
        sourceTextVersionId: "txv_rowan_1",
        documentKey: "doc-1",
        title: "Kitchen renovation invoice",
        docType: "invoice",
        capturedAt: T0,
        evidenceSpanIds: ["spn_rowan_1"],
        publicationState: "active",
      },
      {
        _id: "doc_sage_1",
        _creationTime: T0,
        spaceId: "spc_sage",
        processingGenerationId: "gen_sage_1",
        sourceItemId: "itm_sage_note",
        sourceRevisionId: "rev_sage_1",
        sourceTextVersionId: "txv_sage_1",
        documentKey: "doc-1",
        title: "Garden notes",
        docType: "note",
        capturedAt: T0,
        evidenceSpanIds: ["spn_sage_1"],
        publicationState: "active",
      },
    ],
    chunks: [
      {
        _id: "chk_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        processingGenerationId: "gen_rowan_1",
        documentId: "doc_rowan_1",
        ordinal: 0,
        sourceTextVersionId: "txv_rowan_1",
        start: 0,
        end: ROWAN_TEXT.length,
        text: ROWAN_TEXT,
        evidenceSpanIds: ["spn_rowan_1"],
        publicationState: "active",
      },
      {
        _id: "chk_sage_1",
        _creationTime: T0,
        spaceId: "spc_sage",
        processingGenerationId: "gen_sage_1",
        documentId: "doc_sage_1",
        ordinal: 0,
        sourceTextVersionId: "txv_sage_1",
        start: 0,
        end: SAGE_TEXT.length,
        text: SAGE_TEXT,
        evidenceSpanIds: ["spn_sage_1"],
        publicationState: "active",
      },
    ],
    entities: [
      {
        _id: "ent_rowan_person",
        _creationTime: T0,
        spaceId: "spc_rowan",
        userId: "usr_rowan",
        key: "rowan",
        kind: "person",
        canonicalName: "Rowan Vale",
        normalizedName: "rowan vale",
        aliases: [],
        normalizedAliases: [],
      },
      {
        _id: "ent_sage_person",
        _creationTime: T0,
        spaceId: "spc_sage",
        userId: "usr_sage",
        key: "sage",
        kind: "person",
        canonicalName: "Sage Vale",
        normalizedName: "sage vale",
        aliases: [],
        normalizedAliases: [],
      },
    ],
    thoughts: [
      {
        _id: "tht_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        userId: "usr_rowan",
        content: "Rowan decided to renovate the kitchen this spring.",
        embedding: [0.1, 0.2, 0.3],
        metadata: {
          type: "decision",
          topics: ["home"],
          people: ["Rowan"],
          actionItems: [],
          summary: "Kitchen renovation decision",
        },
      },
    ],
    facts: [
      {
        _id: "fct_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        userId: "usr_rowan",
        subjectEntityId: "ent_rowan_person",
        predicate: "lives_in",
        value: { type: "text", value: "Portland" },
        statement: "Rowan lives in Portland.",
        searchText: "rowan lives in portland",
        sourceType: "user_stated",
        confidence: 0.9,
        status: "current",
      },
    ],
    events: [
      {
        _id: "evt_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        sourceItemId: "itm_rowan_invoice",
        eventKey: "invoice-001",
        createdBy: "usr_rowan",
      },
    ],
    eventVersions: [
      {
        _id: "evv_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        sourceItemId: "itm_rowan_invoice",
        sourceRevisionId: "rev_rowan_1",
        sourceTextVersionId: "txv_rowan_1",
        processingGenerationId: "gen_rowan_1",
        eventId: "evt_rowan_1",
        entityId: "ent_rowan_person",
        eventType: "financial_transaction",
        schemaVersion: 1,
        occurrence: { precision: "date" },
        userId: "usr_rowan",
      },
    ],
    observations: [
      {
        _id: "obs_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        sourceItemId: "itm_rowan_invoice",
        sourceRevisionId: "rev_rowan_1",
        sourceTextVersionId: "txv_rowan_1",
        processingGenerationId: "gen_rowan_1",
        eventId: "evt_rowan_1",
        eventVersionId: "evv_rowan_1",
        entityId: "ent_rowan_person",
        eventType: "financial_transaction",
        occurrence: { precision: "date" },
        observationKey: "total",
        observationType: "amount",
        schemaVersion: 1,
        value: { type: "number", value: 4200, unit: "USD" },
        valueEvidence: ["spn_rowan_1"],
        userId: "usr_rowan",
      },
    ],
    ingestRequests: [
      {
        _id: "req_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        requestId: "req-1",
        requestDigest: sha256("req-1"),
        sourceItemId: "itm_rowan_invoice",
        sourceRevisionId: "rev_rowan_1",
        processingGenerationId: "gen_rowan_1",
        ingestJobId: "job_rowan_1",
        actorUserId: "usr_rowan",
      },
    ],
    ingestJobs: [
      {
        _id: "job_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        sourceItemId: "itm_rowan_invoice",
        sourceRevisionId: "rev_rowan_1",
        processingGenerationId: "gen_rowan_1",
        admittedByUserId: "usr_rowan",
        actorUserId: "usr_rowan",
        desiredProcessingEpoch: 1,
        state: "ready",
        attempts: 1,
        leaseEpoch: 1,
      },
    ],
    // Drained before cutover (`migrated: false`): the export still holding a
    // row here proves the loader really does keep the destination at zero
    // rather than merely never being asked to load one.
    inlineWork: [
      {
        _id: "ilw_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        sourceItemId: "itm_rowan_invoice",
        sourceRevisionId: "rev_rowan_1",
        processingGenerationId: "gen_rowan_1",
        ingestJobId: "job_rowan_1",
        actorUserId: "usr_rowan",
        state: "queued",
        attempts: 0,
      },
    ],
    familyInvitations: [
      {
        _id: "inv_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        emailNormalized: "guest@example.test",
        tokenHash: sha256("invite-token"),
        role: "reader",
        status: "open",
        createdBy: "usr_rowan",
        // Same field name as the structural `_creationTime` column
        // (`createdAt`), covering the naming-collision fix in schema.ts.
        createdAt: T0,
        expiresAt: T0 + DAY,
      },
    ],
    coverageWindows: [
      {
        _id: "cov_rowan_1",
        _creationTime: T0,
        spaceId: "spc_rowan",
        sourceAccountId: "acc_rowan_docs",
        recordType: "financial_transaction",
        from: T0,
        to: T0 + DAY,
        state: "complete",
        lastEnumeratedAt: T0,
        lastProcessedAt: T0,
        discoveredCount: 1,
        indexedCount: 1,
        skippedCount: 0,
      },
    ],
    // Retired (plan 5.1): present in the export like any real Convex table,
    // and never read by the transform because it is absent from `TABLES`.
    lists: [
      { _id: "lst_rowan_1", _creationTime: T0, name: "Renovation punch list", pinned: false, userId: "usr_rowan" },
    ],
  };

  return {
    tables,
    ids: {
      spaceRowan: "spc_rowan",
      spaceSage: "spc_sage",
      documentRowan: "doc_rowan_1",
      documentSage: "doc_sage_1",
      chunkRowan: "chk_rowan_1",
      sourcePageRowan: "pag_rowan_1",
    },
    text: { rowan: ROWAN_TEXT, sage: SAGE_TEXT },
  };
}

/** Writes the synthetic corpus in the Convex export layout (one directory
 * per table, each holding `documents.jsonl`) under `dir`. */
export async function writeConvexExportDir(dir) {
  const { tables, ids, text } = syntheticConvexTables();
  for (const [tableName, rows] of Object.entries(tables)) {
    const tableDir = join(dir, tableName);
    await mkdir(tableDir, { recursive: true });
    const jsonl = rows.map((row) => JSON.stringify(row)).join("\n");
    await writeFile(join(tableDir, "documents.jsonl"), jsonl ? `${jsonl}\n` : "");
  }
  return { dir, ids, text, tableCounts: Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [name, rows.length]),
  ) };
}
