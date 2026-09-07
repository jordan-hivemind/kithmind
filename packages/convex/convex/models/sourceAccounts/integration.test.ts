import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";

const pipeline = internal.models.ingestion.private;

test("registered processing functions publish retained evidence and forget without resurrection", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Synthetic integration owner" }),
  );
  const session = t.withIdentity({
    subject: userId,
    issuer: "https://synthetic.example/convex",
  });
  const sourceAccountId = await session.mutation(
    api.models.sourceAccounts.public.create,
    {
      connector: "synthetic",
      accountId: "integration",
      name: "Synthetic documents",
    },
  );
  const principal = { userId };
  const text = "Synthetic oil service on 2026-08-15.";
  const input = {
    principal,
    sourceAccountId,
    requestId: "synthetic-request-1",
    expectedDesiredProcessingEpoch: 0,
    source: {
      externalId: "synthetic-service",
      title: "Synthetic service",
      docType: "service",
      capturedAt: 1000,
      mediaType: "text/plain",
      inlineText: text,
      uri: "file:///synthetic/service.txt",
    },
    processing: {
      extractionFingerprint: "plain-v1",
      extractorFingerprint: "generic-v1",
      recordSchemaFingerprint: "document-v1",
      normalizationFingerprint: "none-v1",
      chunkerFingerprint: "single-v1",
      correctionRevision: "0",
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
    },
  };
  const admitted = await t.mutation(pipeline.admit, input);
  const leaseToken = "synthetic-internal-lease";
  const claim = await t.mutation(pipeline.claim, {
    principal,
    jobId: admitted.ingestJobId,
    leaseToken,
    leaseDurationMs: 60_000,
  });
  if (!("leaseEpoch" in claim)) throw new Error("Expected a lease");
  const lease = {
    principal,
    jobId: admitted.ingestJobId,
    leaseToken,
    leaseEpoch: claim.leaseEpoch,
  };
  await t.mutation(pipeline.createTextVersion, { ...lease, text });
  const stagedPages = await t.mutation(pipeline.stagePages, {
    ...lease,
    pages: [{ ordinal: 0, start: 0, end: text.length, text }],
  });
  if (!("ids" in stagedPages)) throw new Error("Expected staged pages");
  const stagedSpans = await t.mutation(pipeline.stageEvidenceSpans, {
    ...lease,
    spans: [
      {
        sourcePageId: stagedPages.ids[0]!._id,
        ordinal: 0,
        start: 0,
        end: text.length,
      },
    ],
  });
  if (!("ids" in stagedSpans)) throw new Error("Expected staged evidence");
  const evidenceSpanIds = stagedSpans.ids.map((span) => span._id);
  const stagedDocuments = await t.mutation(pipeline.stageDocuments, {
    ...lease,
    documents: [
      {
        documentKey: "service",
        title: "Synthetic service",
        docType: "service",
        capturedAt: 1000,
        evidenceSpanIds,
      },
    ],
  });
  if (!("ids" in stagedDocuments)) throw new Error("Expected staged documents");
  const documentId = stagedDocuments.ids[0]!._id;
  await t.mutation(pipeline.stageChunks, {
    ...lease,
    chunks: [{ documentId, ordinal: 0, text, evidenceSpanIds }],
  });
  expect(
    await session.query(api.models.documents.public.get, { documentId }),
  ).toBeNull();
  await t.mutation(pipeline.stage, lease);
  await t.mutation(pipeline.activate, lease);
  const document = await session.query(api.models.documents.public.get, {
    documentId,
  });
  expect(document).toMatchObject({
    documentId,
    retainedTextAvailable: true,
    contentStatus: "ready",
    historical: false,
  });
  expect(document!.pages[0]!.evidence[0]!.quote).toBe(text);
  const search = await session.query(api.models.documents.public.search, {
    query: "oil",
  });
  expect(search.results.map((row) => row.documentId)).toEqual([documentId]);
  expect(await t.mutation(pipeline.admit, input)).toMatchObject({
    ingestJobId: admitted.ingestJobId,
  });

  await t.mutation(pipeline.markUnavailable, {
    principal,
    sourceItemId: admitted.sourceItemId,
  });
  expect(
    await session.query(api.models.documents.public.get, { documentId }),
  ).toMatchObject({
    retainedTextAvailable: true,
    originalLinkAvailable: false,
  });
  await t.mutation(pipeline.beginForget, {
    principal,
    sourceItemId: admitted.sourceItemId,
  });
  expect(
    await session.query(api.models.documents.public.get, {
      documentId,
      includeHistorical: true,
    }),
  ).toBeNull();
  let done = false;
  for (let i = 0; i < 30 && !done; i++) {
    const result = await t.mutation(pipeline.continueForget, {
      principal,
      sourceItemId: admitted.sourceItemId,
    });
    expect(result.deleted).toBeLessThanOrEqual(25);
    done = result.done;
  }
  expect(done).toBe(true);
  await expect(t.mutation(pipeline.admit, input)).rejects.toThrow(/forgotten/);
  expect(
    (await session.query(api.models.documents.public.search, { query: "oil" }))
      .results,
  ).toEqual([]);
  const tombstone = await t.run((ctx) => ctx.db.get(admitted.sourceItemId));
  expect(tombstone).toMatchObject({ lifecycle: "forgotten" });
  expect(tombstone!.externalId).toBeUndefined();
  expect(tombstone!.uri).toBeUndefined();
});
