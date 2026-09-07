import { convexTest } from "convex-test";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  createGenerationTextVersion,
  replaceRevokedActorAndRequeueFromWeb,
  stageGenerationPages,
} from "./model";
import { INLINE_RATE_LIMIT, type InlineIngestInput } from "./inlineInput";
import {
  INLINE_WORK_LEASE_MS,
  admitInlineWork,
  claimInlineWork,
  getInlineIngestResult,
  recordInlineWorkFailure,
  reserveRecoverableInlineWork,
} from "./inlineWork";

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Inline owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic inline space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "mcp-client",
      accountId: "account-1",
      name: "Synthetic MCP client",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "c".repeat(64),
      keyPrefix: "inline",
      name: "Inline ingest",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return { userId, spaceId, sourceAccountId, credentialId };
  });
  return {
    t,
    ...ids,
    principal: { userId: ids.userId, credentialId: ids.credentialId },
  };
}

function input(
  spaceId: Id<"spaces">,
  overrides: {
    requestId?: string;
    epoch?: number;
    externalId?: string;
    title?: string;
    text?: string;
    docType?: string;
    capturedAt?: string;
  } = {},
): InlineIngestInput {
  return {
    spaceId,
    requestId: overrides.requestId ?? "request-1",
    expectedDesiredProcessingEpoch: overrides.epoch ?? 0,
    source: {
      connector: "mcp-client",
      accountId: "account-1",
      externalId: overrides.externalId ?? "message-1",
      uri: "mcp://message/1",
      capturedAt: overrides.capturedAt ?? "2026-09-06T12:00:00Z",
    },
    title: overrides.title ?? "Synthetic note",
    text: overrides.text ?? "alpha beta",
    docType: overrides.docType ?? "note",
  };
}

async function admit(
  seeded: Awaited<ReturnType<typeof seed>>,
  value: InlineIngestInput,
  now = 1_000,
) {
  return await seeded.t.run((ctx) =>
    admitInlineWork(ctx, {
      principal: seeded.principal,
      input: value,
      now,
    }),
  );
}

async function runWorker(
  seeded: Awaited<ReturnType<typeof seed>>,
  workId: Id<"inlineWork">,
) {
  return await seeded.t.action(internal.models.ingestion.inlineWorker.process, {
    workId,
  });
}

describe("durable inline worker", () => {
  test("public MCP action uses live credential authentication", async () => {
    const seeded = await seed();
    const priorIssuer = process.env.MCP_JWT_ISSUER;
    process.env.MCP_JWT_ISSUER = "https://synthetic.mcp.test";
    try {
      const mcp = seeded.t.withIdentity({
        issuer: process.env.MCP_JWT_ISSUER,
        subject: seeded.userId,
        apiKeyId: seeded.credentialId,
      });
      const result = await mcp.action(api.models.ingestion.inlineMcp.ingest, {
        input: input(seeded.spaceId),
      });
      expect(result).toMatchObject({
        state: "ready",
        isActive: true,
        desiredProcessingEpoch: 1,
      });
      expect(result.documentId).toBeDefined();
    } finally {
      if (priorIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
      else process.env.MCP_JWT_ISSUER = priorIssuer;
    }
  });

  test("publishes exact text and batches a 64 KiB source", async () => {
    const seeded = await seed();
    const text = "x".repeat(65_536);
    const admitted = await admit(seeded, input(seeded.spaceId, { text }));
    expect(await runWorker(seeded, admitted.workId)).toEqual({
      state: "ready",
    });

    const result = await seeded.t.run((ctx) =>
      getInlineIngestResult(ctx, {
        principal: seeded.principal,
        workId: admitted.workId,
      }),
    );
    expect(result).toMatchObject({ state: "ready", isActive: true });
    const stored = await seeded.t.run(async (ctx) => ({
      revision: await ctx.db.get(admitted.admission.sourceRevisionId),
      spans: await ctx.db.query("evidenceSpans").collect(),
      chunks: await ctx.db.query("chunks").collect(),
    }));
    expect(stored.revision?.inlineText).toBe(text);
    expect(stored.spans).toHaveLength(32);
    expect(stored.chunks).toHaveLength(32);
    expect(stored.chunks.map((chunk) => chunk.text).join("")).toBe(text);
  });

  test("resumes idempotently after a crash between staging mutations", async () => {
    const seeded = await seed();
    const admitted = await admit(seeded, input(seeded.spaceId));
    const claimed = await seeded.t.run((ctx) =>
      claimInlineWork(ctx, {
        workId: admitted.workId,
        leaseToken: "crashed-worker",
        now: 1_100,
      }),
    );
    if (claimed.kind !== "claimed") throw new Error("Expected claim");
    await seeded.t.run(async (ctx) => {
      await createGenerationTextVersion(ctx, {
        principal: claimed.principal,
        jobId: claimed.jobId,
        leaseEpoch: claimed.leaseEpoch,
        leaseToken: claimed.leaseToken,
        now: 1_101,
        text: claimed.text,
      });
      await stageGenerationPages(ctx, {
        principal: claimed.principal,
        jobId: claimed.jobId,
        leaseEpoch: claimed.leaseEpoch,
        leaseToken: claimed.leaseToken,
        now: 1_102,
        pages: [
          {
            ordinal: 0,
            start: 0,
            end: claimed.text.length,
            text: claimed.text,
          },
        ],
      });
    });

    expect(await runWorker(seeded, admitted.workId)).toEqual({
      state: "ready",
    });
    const counts = await seeded.t.run(async (ctx) => ({
      pages: (await ctx.db.query("sourcePages").collect()).length,
      documents: (await ctx.db.query("documents").collect()).length,
      chunks: (await ctx.db.query("chunks").collect()).length,
    }));
    expect(counts).toEqual({ pages: 1, documents: 1, chunks: 1 });
  });

  test("revocation stops work and explicit web repair can resume it", async () => {
    const seeded = await seed();
    const admitted = await admit(seeded, input(seeded.spaceId));
    await seeded.t.run((ctx) => ctx.db.delete(seeded.credentialId));
    const denied = await seeded.t.run((ctx) =>
      claimInlineWork(ctx, {
        workId: admitted.workId,
        leaseToken: "revoked-worker",
        now: 1_100,
      }),
    );
    expect(denied).toEqual({ kind: "denied" });
    expect(
      await seeded.t.run((ctx) => ctx.db.query("documents").collect()),
    ).toHaveLength(0);

    await seeded.t.run((ctx) =>
      replaceRevokedActorAndRequeueFromWeb(ctx, {
        principal: { userId: seeded.userId },
        jobId: admitted.admission.ingestJobId,
        now: 1_200,
      }),
    );
    const reserved = await seeded.t.run((ctx) =>
      reserveRecoverableInlineWork(ctx, 1_200),
    );
    expect(reserved).toEqual([admitted.workId]);
    expect(await runWorker(seeded, admitted.workId)).toEqual({
      state: "ready",
    });
  });

  test("a stale worker failure cannot overwrite a newer lease", async () => {
    const seeded = await seed();
    const admitted = await admit(seeded, input(seeded.spaceId));
    const first = await seeded.t.run((ctx) =>
      claimInlineWork(ctx, {
        workId: admitted.workId,
        leaseToken: "lease-a",
        now: 1_000,
      }),
    );
    if (first.kind !== "claimed") throw new Error("Expected first claim");
    const secondAt = 1_000 + INLINE_WORK_LEASE_MS + 1;
    const second = await seeded.t.run((ctx) =>
      claimInlineWork(ctx, {
        workId: admitted.workId,
        leaseToken: "lease-b",
        now: secondAt,
      }),
    );
    if (second.kind !== "claimed") throw new Error("Expected second claim");
    const stale = await seeded.t.run((ctx) =>
      recordInlineWorkFailure(ctx, {
        workId: admitted.workId,
        leaseEpoch: first.leaseEpoch,
        leaseToken: first.leaseToken,
        now: secondAt + 1,
        error: "Not authenticated",
      }),
    );
    expect(stale).toEqual({ state: "stale" });
    const current = await seeded.t.run(async (ctx) => ({
      work: await ctx.db.get(admitted.workId),
      job: await ctx.db.get(admitted.admission.ingestJobId),
    }));
    expect(current.work).toMatchObject({
      state: "running",
      nextAttemptAt: secondAt + INLINE_WORK_LEASE_MS,
    });
    expect(current.job).toMatchObject({
      state: "processing",
      leaseEpoch: second.leaseEpoch,
      leaseToken: "lease-b",
    });
  });

  test("recovery cannot downgrade activated work after actor revocation", async () => {
    const seeded = await seed();
    const admitted = await admit(seeded, input(seeded.spaceId));
    await runWorker(seeded, admitted.workId);
    await seeded.t.run(async (ctx) => {
      await ctx.db.patch(admitted.workId, {
        state: "running",
        nextAttemptAt: 2_000,
      });
      await ctx.db.delete(seeded.credentialId);
    });
    expect(
      await seeded.t.run((ctx) => reserveRecoverableInlineWork(ctx, 2_001)),
    ).toEqual([]);
    const preserved = await seeded.t.run(async (ctx) => ({
      work: await ctx.db.get(admitted.workId),
      job: await ctx.db.get(admitted.admission.ingestJobId),
      generation: await ctx.db.get(admitted.admission.processingGenerationId),
      item: await ctx.db.get(admitted.admission.sourceItemId),
    }));
    expect(preserved.work?.state).toBe("ready");
    expect(preserved.job?.state).toBe("ready");
    expect(preserved.generation?.state).toBe("ready");
    expect(preserved.item?.activeGenerationId).toBe(
      admitted.admission.processingGenerationId,
    );
  });

  test("bounded crash recovery moves exhausted work to needs review", async () => {
    const seeded = await seed();
    const admitted = await admit(seeded, input(seeded.spaceId));
    let now = 10_000;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const claimed = await seeded.t.run((ctx) =>
        claimInlineWork(ctx, {
          workId: admitted.workId,
          leaseToken: `crash-${attempt}`,
          now,
        }),
      );
      expect(claimed.kind).toBe("claimed");
      now += INLINE_WORK_LEASE_MS + 1;
    }
    const exhausted = await seeded.t.run((ctx) =>
      claimInlineWork(ctx, {
        workId: admitted.workId,
        leaseToken: "ninth-attempt",
        now,
      }),
    );
    expect(exhausted).toEqual({ kind: "terminal", state: "needs_review" });
    const states = await seeded.t.run(async (ctx) => ({
      work: await ctx.db.get(admitted.workId),
      job: await ctx.db.get(admitted.admission.ingestJobId),
      generation: await ctx.db.get(admitted.admission.processingGenerationId),
    }));
    expect(states.work).toMatchObject({
      state: "needs_review",
      lastErrorCode: "inline_worker_attempts_exhausted",
    });
    expect(states.job?.state).toBe("needs_review");
    expect(states.generation?.state).toBe("needs_review");
  });

  test("recovery quarantines a corrupt row without starving valid work", async () => {
    const seeded = await seed();
    const corrupt = await admit(
      seeded,
      input(seeded.spaceId, {
        requestId: "corrupt",
        externalId: "corrupt",
      }),
      20_000,
    );
    const valid = await admit(
      seeded,
      input(seeded.spaceId, {
        requestId: "valid",
        externalId: "valid",
      }),
      20_000,
    );
    await seeded.t.run((ctx) =>
      ctx.db.patch(corrupt.admission.processingGenerationId, {
        sourceItemId: valid.admission.sourceItemId,
      }),
    );
    const reserved = await seeded.t.run((ctx) =>
      reserveRecoverableInlineWork(ctx, 20_000),
    );
    expect(reserved).toEqual([valid.workId]);
    expect(
      await seeded.t.run((ctx) => ctx.db.get(corrupt.workId)),
    ).toMatchObject({
      state: "needs_review",
      lastErrorCode: "invalid_work_chain",
    });
    expect(await runWorker(seeded, valid.workId)).toEqual({ state: "ready" });
  });

  test("conflicting request IDs fail without consuming another rate slot", async () => {
    const seeded = await seed();
    const original = input(seeded.spaceId);
    await admit(seeded, original);
    await expect(
      admit(seeded, { ...original, title: "Changed title" }, 1_001),
    ).rejects.toThrow("requestId conflicts with a different request");
    const limiter = await seeded.t.run((ctx) =>
      ctx.db.query("ingestRateLimits").unique(),
    );
    expect(limiter?.count).toBe(1);
  });

  test("matching receipt retries are exempt from the new-admission limit", async () => {
    const seeded = await seed();
    for (let index = 0; index < INLINE_RATE_LIMIT; index += 1) {
      await admit(
        seeded,
        input(seeded.spaceId, {
          requestId: `request-${index}`,
          externalId: `message-${index}`,
        }),
        2_000,
      );
    }
    const retry = await admit(
      seeded,
      input(seeded.spaceId, {
        requestId: "request-0",
        externalId: "message-0",
      }),
      2_001,
    );
    expect(retry.reused).toBe(true);
    await expect(
      admit(
        seeded,
        input(seeded.spaceId, {
          requestId: "request-over-limit",
          externalId: "message-over-limit",
        }),
        2_001,
      ),
    ).rejects.toThrow("Ingest rate limit exceeded");
  });

  test("A to B to A corrections activate new generations and historical retry stays historical", async () => {
    const seeded = await seed();
    const firstInput = input(seeded.spaceId, { requestId: "a-1", text: "A" });
    const first = await admit(seeded, firstInput, 3_000);
    await runWorker(seeded, first.workId);
    const second = await admit(
      seeded,
      input(seeded.spaceId, { requestId: "b", epoch: 1, text: "B" }),
      3_001,
    );
    await runWorker(seeded, second.workId);
    const third = await admit(
      seeded,
      input(seeded.spaceId, { requestId: "a-2", epoch: 2, text: "A" }),
      3_002,
    );
    await runWorker(seeded, third.workId);

    expect(third.admission.processingGenerationId).not.toBe(
      first.admission.processingGenerationId,
    );
    const historicalRetry = await admit(seeded, firstInput, 3_003);
    await runWorker(seeded, historicalRetry.workId);
    const historical = await seeded.t.run((ctx) =>
      getInlineIngestResult(ctx, {
        principal: seeded.principal,
        workId: historicalRetry.workId,
      }),
    );
    expect(historical).toMatchObject({
      state: "ready",
      isActive: false,
      desiredProcessingEpoch: 3,
    });
    const active = await seeded.t.run((ctx) =>
      ctx.db.get(third.admission.sourceItemId),
    );
    expect(active?.activeGenerationId).toBe(
      third.admission.processingGenerationId,
    );
  });

  test("same bytes with changed metadata creates a new document generation", async () => {
    const seeded = await seed();
    const first = await admit(
      seeded,
      input(seeded.spaceId, { requestId: "metadata-1", text: "same" }),
      4_000,
    );
    await runWorker(seeded, first.workId);
    const changed = await admit(
      seeded,
      input(seeded.spaceId, {
        requestId: "metadata-2",
        epoch: 1,
        text: "same",
        title: "Changed title",
        docType: "changed-type",
        capturedAt: "2026-09-07T12:00:00Z",
      }),
      4_001,
    );
    await runWorker(seeded, changed.workId);
    const rows = await seeded.t.run(async (ctx) => ({
      revision: await ctx.db.get(changed.admission.sourceRevisionId),
      documents: await ctx.db.query("documents").collect(),
    }));
    const activeDocument = rows.documents.find(
      (document) =>
        document.processingGenerationId ===
        changed.admission.processingGenerationId,
    );
    expect(activeDocument).toMatchObject({
      title: "Changed title",
      docType: "changed-type",
      capturedAt: Date.parse("2026-09-06T12:00:00Z"),
    });
    expect(rows.revision?.capturedAt).toBe(Date.parse("2026-09-06T12:00:00Z"));
  });

  test("result lookup rejects a document with cross-space parents", async () => {
    const seeded = await seed();
    const admitted = await admit(seeded, input(seeded.spaceId));
    await runWorker(seeded, admitted.workId);
    await seeded.t.run(async (ctx) => {
      const document = await ctx.db
        .query("documents")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq(
            "processingGenerationId",
            admitted.admission.processingGenerationId,
          ),
        )
        .unique();
      if (!document) throw new Error("Expected document");
      const otherSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Other synthetic space",
        createdBy: seeded.userId,
      });
      await ctx.db.patch(document._id, { spaceId: otherSpaceId });
    });
    await expect(
      seeded.t.run((ctx) =>
        getInlineIngestResult(ctx, {
          principal: seeded.principal,
          workId: admitted.workId,
        }),
      ),
    ).rejects.toThrow("Inline document parent chain is invalid");
  });
});
