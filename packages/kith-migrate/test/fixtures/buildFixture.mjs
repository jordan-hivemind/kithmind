import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Every primary key and reference in this fixture must satisfy
// `@repo/kith-store`'s `kith.kith_id` domain (lowercase alphanumeric,
// 20-64 characters, no underscore) once loaded, since every id/space_id/ref
// column in the generated schema is typed to that domain. A short label such
// as "usr_rowan" is far more readable below than a random id would be, so
// `id(label)` derives a deterministic, compliant id from the label instead:
// the same label always yields the same id, and the call site keeps the
// label as its own comment.
const idCache = new Map();
function id(label) {
  let value = idCache.get(label);
  if (!value) {
    value = `id${createHash("sha1").update(label).digest("hex").slice(0, 24)}`;
    idCache.set(label, value);
  }
  return value;
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
      { _id: id("usr_rowan"), _creationTime: T0, name: "Rowan Vale", email: "rowan@example.test" },
      { _id: id("usr_sage"), _creationTime: T0, name: "Sage Vale", email: "sage@example.test" },
    ],
    authAccounts: [
      {
        _id: id("aac_rowan_pw"),
        _creationTime: T0,
        userId: id("usr_rowan"),
        type: "credentials",
        provider: "password",
        providerAccountId: "rowan@example.test",
        secret: "scrypt:synthetic-secret",
      },
    ],
    spaces: [
      { _id: id("spc_rowan"), _creationTime: T0, kind: "shared", name: "Rowan household", createdBy: id("usr_rowan") },
      { _id: id("spc_sage"), _creationTime: T0, kind: "personal", name: "Sage household", createdBy: id("usr_sage") },
    ],
    spaceMembers: [
      { _id: id("mem_rowan_owner"), _creationTime: T0, spaceId: id("spc_rowan"), userId: id("usr_rowan"), role: "owner" },
      { _id: id("mem_sage_owner"), _creationTime: T0, spaceId: id("spc_sage"), userId: id("usr_sage"), role: "owner" },
    ],
    userSpaceSettings: [
      { _id: id("uss_rowan"), _creationTime: T0, userId: id("usr_rowan"), personalSpaceId: id("spc_rowan") },
      { _id: id("uss_sage"), _creationTime: T0, userId: id("usr_sage"), personalSpaceId: id("spc_sage") },
    ],
    apiKeys: [
      {
        _id: id("key_rowan"),
        _creationTime: T0,
        userId: id("usr_rowan"),
        keyHash: sha256("synthetic-api-key"),
        keyPrefix: "km_abcd",
        name: "rowan-mcp",
        capabilities: ["read", "write"],
        spaceIds: [id("spc_rowan")],
        sourceAccountIds: [id("acc_rowan_docs")],
      },
    ],
    sourceAccounts: [
      {
        _id: id("acc_rowan_docs"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        connector: "local_folder",
        accountId: "rowan-docs",
        name: "Rowan Documents",
        enabled: true,
        cursorVersion: 1,
        freshnessMs: 60_000,
        createdBy: id("usr_rowan"),
      },
      {
        _id: id("acc_sage_docs"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        connector: "local_folder",
        accountId: "sage-docs",
        name: "Sage Documents",
        enabled: true,
        cursorVersion: 1,
        freshnessMs: 60_000,
        createdBy: id("usr_sage"),
      },
    ],
    sourceItems: [
      {
        _id: id("itm_rowan_invoice"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
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
        _id: id("itm_sage_note"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        sourceAccountId: id("acc_sage_docs"),
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
        _id: id("rev_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceItemId: id("itm_rowan_invoice"),
        contentHash: sha256("rowan-invoice-bytes"),
        byteLength: 2048,
        mediaType: "application/pdf",
        capturedAt: T0,
        userId: id("usr_rowan"),
      },
      {
        _id: id("rev_sage_1"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        sourceItemId: id("itm_sage_note"),
        contentHash: sha256("sage-note-bytes"),
        byteLength: 512,
        mediaType: "text/plain",
        capturedAt: T0,
        userId: id("usr_sage"),
      },
    ],
    sourceTextVersions: [
      {
        _id: id("txv_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceRevisionId: id("rev_rowan_1"),
        extractionFingerprint: "fp1",
        text: ROWAN_TEXT,
        textHash: sha256(ROWAN_TEXT),
        byteLength: Buffer.byteLength(ROWAN_TEXT, "utf8"),
        evidenceSealed: true,
      },
      {
        _id: id("txv_sage_1"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        sourceRevisionId: id("rev_sage_1"),
        extractionFingerprint: "fp1",
        text: SAGE_TEXT,
        textHash: sha256(SAGE_TEXT),
        byteLength: Buffer.byteLength(SAGE_TEXT, "utf8"),
        evidenceSealed: true,
      },
    ],
    sourcePages: [
      {
        _id: id("pag_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceTextVersionId: id("txv_rowan_1"),
        ordinal: 1,
        start: 0,
        end: ROWAN_TEXT.length,
        text: ROWAN_TEXT,
        textHash: sha256(ROWAN_TEXT),
      },
      {
        _id: id("pag_sage_1"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        sourceTextVersionId: id("txv_sage_1"),
        ordinal: 1,
        start: 0,
        end: SAGE_TEXT.length,
        text: SAGE_TEXT,
        textHash: sha256(SAGE_TEXT),
      },
    ],
    evidenceSpans: [
      {
        _id: id("spn_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceRevisionId: id("rev_rowan_1"),
        sourceTextVersionId: id("txv_rowan_1"),
        sourcePageId: id("pag_rowan_1"),
        ordinal: 0,
        start: 0,
        end: ROWAN_QUOTE.length,
        quoteHash: sha256(ROWAN_QUOTE),
      },
      {
        _id: id("spn_sage_1"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        sourceRevisionId: id("rev_sage_1"),
        sourceTextVersionId: id("txv_sage_1"),
        sourcePageId: id("pag_sage_1"),
        ordinal: 0,
        start: 0,
        end: SAGE_QUOTE.length,
        quoteHash: sha256(SAGE_QUOTE),
      },
    ],
    processingGenerations: [
      {
        _id: id("gen_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
        sourceItemId: id("itm_rowan_invoice"),
        sourceRevisionId: id("rev_rowan_1"),
        sourceTextVersionId: id("txv_rowan_1"),
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
        _id: id("gen_sage_1"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        sourceAccountId: id("acc_sage_docs"),
        sourceItemId: id("itm_sage_note"),
        sourceRevisionId: id("rev_sage_1"),
        sourceTextVersionId: id("txv_sage_1"),
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
        _id: id("doc_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        processingGenerationId: id("gen_rowan_1"),
        sourceItemId: id("itm_rowan_invoice"),
        sourceRevisionId: id("rev_rowan_1"),
        sourceTextVersionId: id("txv_rowan_1"),
        documentKey: "doc-1",
        title: "Kitchen renovation invoice",
        docType: "invoice",
        capturedAt: T0,
        evidenceSpanIds: [id("spn_rowan_1")],
        publicationState: "active",
      },
      {
        _id: id("doc_sage_1"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        processingGenerationId: id("gen_sage_1"),
        sourceItemId: id("itm_sage_note"),
        sourceRevisionId: id("rev_sage_1"),
        sourceTextVersionId: id("txv_sage_1"),
        documentKey: "doc-1",
        title: "Garden notes",
        docType: "note",
        capturedAt: T0,
        evidenceSpanIds: [id("spn_sage_1")],
        publicationState: "active",
      },
    ],
    chunks: [
      {
        _id: id("chk_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        processingGenerationId: id("gen_rowan_1"),
        documentId: id("doc_rowan_1"),
        ordinal: 0,
        sourceTextVersionId: id("txv_rowan_1"),
        start: 0,
        end: ROWAN_TEXT.length,
        text: ROWAN_TEXT,
        evidenceSpanIds: [id("spn_rowan_1")],
        publicationState: "active",
      },
      {
        _id: id("chk_sage_1"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        processingGenerationId: id("gen_sage_1"),
        documentId: id("doc_sage_1"),
        ordinal: 0,
        sourceTextVersionId: id("txv_sage_1"),
        start: 0,
        end: SAGE_TEXT.length,
        text: SAGE_TEXT,
        evidenceSpanIds: [id("spn_sage_1")],
        publicationState: "active",
      },
    ],
    entities: [
      {
        _id: id("ent_rowan_person"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        userId: id("usr_rowan"),
        key: "rowan",
        kind: "person",
        canonicalName: "Rowan Vale",
        normalizedName: "rowan vale",
        aliases: [],
        normalizedAliases: [],
      },
      {
        _id: id("ent_sage_person"),
        _creationTime: T0,
        spaceId: id("spc_sage"),
        userId: id("usr_sage"),
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
        _id: id("tht_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        userId: id("usr_rowan"),
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
        _id: id("fct_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        userId: id("usr_rowan"),
        subjectEntityId: id("ent_rowan_person"),
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
        _id: id("evt_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
        sourceItemId: id("itm_rowan_invoice"),
        eventKey: "invoice-001",
        createdBy: id("usr_rowan"),
      },
    ],
    eventVersions: [
      {
        _id: id("evv_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
        sourceItemId: id("itm_rowan_invoice"),
        sourceRevisionId: id("rev_rowan_1"),
        sourceTextVersionId: id("txv_rowan_1"),
        processingGenerationId: id("gen_rowan_1"),
        eventId: id("evt_rowan_1"),
        entityId: id("ent_rowan_person"),
        eventType: "financial_transaction",
        schemaVersion: 1,
        occurrence: { precision: "date" },
        userId: id("usr_rowan"),
      },
    ],
    observations: [
      {
        _id: id("obs_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
        sourceItemId: id("itm_rowan_invoice"),
        sourceRevisionId: id("rev_rowan_1"),
        sourceTextVersionId: id("txv_rowan_1"),
        processingGenerationId: id("gen_rowan_1"),
        eventId: id("evt_rowan_1"),
        eventVersionId: id("evv_rowan_1"),
        entityId: id("ent_rowan_person"),
        eventType: "financial_transaction",
        occurrence: { precision: "date" },
        observationKey: "total",
        observationType: "amount",
        schemaVersion: 1,
        value: { type: "number", value: 4200, unit: "USD" },
        valueEvidence: [id("spn_rowan_1")],
        userId: id("usr_rowan"),
      },
    ],
    ingestRequests: [
      {
        _id: id("req_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
        requestId: "req-1",
        requestDigest: sha256("req-1"),
        sourceItemId: id("itm_rowan_invoice"),
        sourceRevisionId: id("rev_rowan_1"),
        processingGenerationId: id("gen_rowan_1"),
        ingestJobId: id("job_rowan_1"),
        actorUserId: id("usr_rowan"),
      },
    ],
    ingestJobs: [
      {
        _id: id("job_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
        sourceItemId: id("itm_rowan_invoice"),
        sourceRevisionId: id("rev_rowan_1"),
        processingGenerationId: id("gen_rowan_1"),
        admittedByUserId: id("usr_rowan"),
        actorUserId: id("usr_rowan"),
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
        _id: id("ilw_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
        sourceItemId: id("itm_rowan_invoice"),
        sourceRevisionId: id("rev_rowan_1"),
        processingGenerationId: id("gen_rowan_1"),
        ingestJobId: id("job_rowan_1"),
        actorUserId: id("usr_rowan"),
        state: "queued",
        attempts: 0,
      },
    ],
    familyInvitations: [
      {
        _id: id("inv_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        emailNormalized: "guest@example.test",
        tokenHash: sha256("invite-token"),
        role: "reader",
        status: "open",
        createdBy: id("usr_rowan"),
        // Same field name as the structural `_creationTime` column
        // (`createdAt`), covering the naming-collision fix in schema.ts.
        createdAt: T0,
        expiresAt: T0 + DAY,
      },
    ],
    coverageWindows: [
      {
        _id: id("cov_rowan_1"),
        _creationTime: T0,
        spaceId: id("spc_rowan"),
        sourceAccountId: id("acc_rowan_docs"),
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
      { _id: id("lst_rowan_1"), _creationTime: T0, name: "Renovation punch list", pinned: false, userId: id("usr_rowan") },
    ],
  };

  return {
    tables,
    ids: {
      spaceRowan: id("spc_rowan"),
      spaceSage: id("spc_sage"),
      documentRowan: id("doc_rowan_1"),
      documentSage: id("doc_sage_1"),
      chunkRowan: id("chk_rowan_1"),
      sourcePageRowan: id("pag_rowan_1"),
      sourceItemRowan: id("itm_rowan_invoice"),
      sourceItemSage: id("itm_sage_note"),
      thoughtRowan: id("tht_rowan_1"),
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
