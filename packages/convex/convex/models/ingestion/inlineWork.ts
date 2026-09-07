import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";
import type { PrincipalRef } from "../../lib/spaces";
import {
  consumeIngestAdmissionRateLimit,
  inlineAdmissionDigest,
  inlineAdmissionInput,
  prepareInlineInput,
  resolveIngestSourceAccount,
  type InlineIngestInput,
} from "./inlineInput";
import { MAX_LEASE_MS } from "./limits";
import {
  admitSourceRevision,
  claimJob,
  failJob,
  type AdmissionResult,
} from "./model";

export const INLINE_WORK_BATCH_SIZE = 10;
export const INLINE_WORK_LEASE_MS = MAX_LEASE_MS;
export const INLINE_WORK_FALLBACK_DELAY_MS = 5_000;
export const INLINE_WORK_MAX_BACKOFF_MS = 60 * 60 * 1_000;

export type InlineIngestResult = {
  sourceItemId: Id<"sourceItems">;
  sourceRevisionId: Id<"sourceRevisions">;
  processingGenerationId: Id<"processingGenerations">;
  ingestJobId: Id<"ingestJobs">;
  documentId?: Id<"documents">;
  desiredProcessingEpoch: number;
  isActive: boolean;
  state: "ready" | "queued" | "needs_review" | "failed";
};

type WorkPrincipal = { userId: Id<"users">; credentialId: Id<"apiKeys"> };

function actorRef(job: Doc<"ingestJobs">): PrincipalRef {
  return {
    userId: job.actorUserId,
    ...(job.actorCredentialId ? { credentialId: job.actorCredentialId } : {}),
  };
}

function boundedErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("authenticated") ||
    message.includes("Source account not found") ||
    message.includes("Space not found")
  ) {
    return "authorization_revoked";
  }
  if (
    message.includes("conflict") ||
    message.includes("invalid") ||
    message.includes("incomplete") ||
    message.includes("exceeds") ||
    message.includes("does not") ||
    message.includes("damaged")
  ) {
    return "invalid_staging";
  }
  return "inline_worker_error";
}

function hasCurrentLease(
  job: Doc<"ingestJobs">,
  args: { leaseEpoch: number; leaseToken: string; now: number },
): boolean {
  return (
    job.leaseEpoch === args.leaseEpoch &&
    job.leaseToken === args.leaseToken &&
    job.leaseExpiresAt !== undefined &&
    job.leaseExpiresAt > args.now
  );
}

async function markInlineAuthorizationRevoked(
  ctx: MutationCtx,
  work: Doc<"inlineWork">,
  job: Doc<"ingestJobs">,
  now: number,
): Promise<void> {
  if (job.state === "ready") {
    await ctx.db.patch(work._id, {
      state: "ready",
      nextAttemptAt: undefined,
      lastErrorCode: undefined,
      updatedAt: now,
    });
    return;
  }
  const generation = await ctx.db.get(work.processingGenerationId);
  if (!generation || generation.spaceId !== work.spaceId) {
    throw new Error("Inline work generation is invalid");
  }
  const error = {
    code: "authorization_revoked",
    message: "Inline ingest actor is no longer authorized",
    retryable: false,
    at: now,
  };
  await ctx.db.patch(job._id, {
    state: "failed",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
    error,
  });
  await ctx.db.patch(generation._id, { state: "failed" });
  await ctx.db.patch(work._id, {
    state: "failed",
    attempts: job.attempts,
    nextAttemptAt: undefined,
    lastErrorCode: error.code,
    updatedAt: now,
  });
}

async function requireWorkChain(
  ctx: MutationCtx,
  workId: Id<"inlineWork">,
): Promise<{ work: Doc<"inlineWork">; job: Doc<"ingestJobs"> }> {
  const work = await ctx.db.get(workId);
  if (!work) throw new Error("Inline work not found");
  const job = await ctx.db.get(work.ingestJobId);
  const [item, revision, generation] = await Promise.all([
    ctx.db.get(work.sourceItemId),
    ctx.db.get(work.sourceRevisionId),
    ctx.db.get(work.processingGenerationId),
  ]);
  if (
    !job ||
    job.spaceId !== work.spaceId ||
    job.sourceAccountId !== work.sourceAccountId ||
    job.sourceItemId !== work.sourceItemId ||
    job.sourceRevisionId !== work.sourceRevisionId ||
    job.processingGenerationId !== work.processingGenerationId ||
    !item ||
    item.spaceId !== work.spaceId ||
    item.sourceAccountId !== work.sourceAccountId ||
    !revision ||
    revision.spaceId !== work.spaceId ||
    revision.sourceItemId !== work.sourceItemId ||
    !generation ||
    generation.spaceId !== work.spaceId ||
    generation.sourceAccountId !== work.sourceAccountId ||
    generation.sourceItemId !== work.sourceItemId ||
    generation.sourceRevisionId !== work.sourceRevisionId ||
    generation.desiredProcessingEpoch !== job.desiredProcessingEpoch
  ) {
    throw new Error("Inline work parent chain is invalid");
  }
  return { work, job };
}

async function createOrGetInlineWork(
  ctx: MutationCtx,
  args: {
    principal: WorkPrincipal;
    admission: AdmissionResult;
    now: number;
  },
): Promise<{ work: Doc<"inlineWork">; created: boolean }> {
  const matches = await ctx.db
    .query("inlineWork")
    .withIndex("by_ingestJobId", (q) =>
      q.eq("ingestJobId", args.admission.ingestJobId),
    )
    .take(2);
  if (matches.length > 1) throw new Error("Inline work identity is invalid");
  const existing = matches[0];
  if (existing) {
    if (
      existing.sourceItemId !== args.admission.sourceItemId ||
      existing.sourceRevisionId !== args.admission.sourceRevisionId ||
      existing.processingGenerationId !== args.admission.processingGenerationId
    ) {
      throw new Error("Inline work conflicts with its ingest receipt");
    }
    return { work: existing, created: false };
  }
  const job = await ctx.db.get(args.admission.ingestJobId);
  if (!job) throw new Error("Ingest job not found");
  const id = await ctx.db.insert("inlineWork", {
    spaceId: job.spaceId,
    sourceAccountId: job.sourceAccountId,
    sourceItemId: job.sourceItemId,
    sourceRevisionId: job.sourceRevisionId,
    processingGenerationId: job.processingGenerationId,
    ingestJobId: job._id,
    actorUserId: job.actorUserId,
    ...(job.actorCredentialId
      ? { actorCredentialId: job.actorCredentialId }
      : {}),
    state:
      job.state === "ready"
        ? "ready"
        : job.state === "needs_review"
          ? "needs_review"
          : job.state === "obsolete_generation"
            ? "obsolete_generation"
            : job.state === "failed" && !job.error?.retryable
              ? "failed"
              : "queued",
    attempts: job.attempts,
    nextAttemptAt:
      job.state === "ready" || job.state === "needs_review"
        ? undefined
        : (job.nextAttemptAt ?? args.now),
    createdAt: args.now,
    updatedAt: args.now,
  });
  return { work: (await ctx.db.get(id))!, created: true };
}

/** Atomic authorization, receipt conflict check, rate limiting, and admission. */
export async function admitInlineWork(
  ctx: MutationCtx,
  args: {
    principal: WorkPrincipal;
    input: InlineIngestInput;
    now: number;
  },
) {
  const prepared = prepareInlineInput(args.input);
  const account = await resolveIngestSourceAccount(ctx, args.principal, {
    spaceId: args.input.spaceId,
    connector: args.input.source.connector,
    accountId: args.input.source.accountId,
  });
  const admissionInput = inlineAdmissionInput(
    args.principal,
    account._id,
    prepared,
  );
  const requestDigest = await inlineAdmissionDigest(admissionInput);
  const receipts = await ctx.db
    .query("ingestRequests")
    .withIndex("by_sourceAccountId_and_requestId", (q) =>
      q
        .eq("sourceAccountId", account._id)
        .eq("requestId", args.input.requestId),
    )
    .take(2);
  if (receipts.length > 1) throw new Error("Duplicate ingest request identity");
  if (receipts[0]?.requestDigest !== undefined) {
    if (receipts[0].requestDigest !== requestDigest) {
      throw new Error("requestId conflicts with a different request");
    }
  } else {
    await consumeIngestAdmissionRateLimit(ctx, {
      credentialId: args.principal.credentialId,
      now: args.now,
    });
  }
  const admission = await admitSourceRevision(ctx, admissionInput);
  const { work, created } = await createOrGetInlineWork(ctx, {
    principal: args.principal,
    admission,
    now: args.now,
  });
  return {
    admission,
    workId: work._id,
    reused: admission.reused,
    newWork: created,
  };
}

export async function claimInlineWork(
  ctx: MutationCtx,
  args: { workId: Id<"inlineWork">; leaseToken: string; now: number },
) {
  const { work, job } = await requireWorkChain(ctx, args.workId);
  if (
    job.state === "ready" ||
    job.state === "needs_review" ||
    job.state === "obsolete_generation" ||
    (job.state === "failed" && !job.error?.retryable)
  ) {
    const state =
      job.state === "ready"
        ? "ready"
        : job.state === "needs_review"
          ? "needs_review"
          : job.state === "obsolete_generation"
            ? "obsolete_generation"
            : "failed";
    if (work.state !== state) {
      await ctx.db.patch(work._id, {
        state,
        nextAttemptAt: undefined,
        updatedAt: args.now,
      });
    }
    return { kind: "terminal" as const, state };
  }
  if (
    job.leaseToken !== undefined &&
    job.leaseExpiresAt !== undefined &&
    job.leaseExpiresAt > args.now
  ) {
    await ctx.db.patch(work._id, {
      state: "running",
      nextAttemptAt: job.leaseExpiresAt,
      updatedAt: args.now,
    });
    return { kind: "busy" as const, retryAt: job.leaseExpiresAt };
  }
  if (
    job.state === "failed" &&
    job.error?.retryable &&
    job.nextAttemptAt !== undefined &&
    job.nextAttemptAt > args.now
  ) {
    await ctx.db.patch(work._id, {
      state: "failed",
      nextAttemptAt: job.nextAttemptAt,
      updatedAt: args.now,
    });
    return { kind: "busy" as const, retryAt: job.nextAttemptAt };
  }
  try {
    await requireSourceAccountAccess(
      ctx,
      actorRef(job),
      work.sourceAccountId,
      "ingest",
    );
    let claim: Awaited<ReturnType<typeof claimJob>>;
    try {
      claim = await claimJob(ctx, {
        principal: actorRef(job),
        jobId: work.ingestJobId,
        leaseToken: args.leaseToken,
        leaseDurationMs: INLINE_WORK_LEASE_MS,
        now: args.now,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("attempt limit reached")
      ) {
        throw error;
      }
      const generation = await ctx.db.get(work.processingGenerationId);
      if (!generation || generation.spaceId !== work.spaceId) {
        throw new Error("Inline work generation is invalid");
      }
      const failure = {
        code: "inline_worker_attempts_exhausted",
        message: "Inline worker attempt limit reached",
        retryable: false,
        at: args.now,
      };
      await ctx.db.patch(job._id, {
        state: "needs_review",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: undefined,
        error: failure,
      });
      await ctx.db.patch(generation._id, { state: "needs_review" });
      await ctx.db.patch(work._id, {
        state: "needs_review",
        nextAttemptAt: undefined,
        lastErrorCode: failure.code,
        updatedAt: args.now,
      });
      return { kind: "terminal" as const, state: "needs_review" as const };
    }
    if (claim.state === "obsolete_generation") {
      await ctx.db.patch(work._id, {
        state: "obsolete_generation",
        nextAttemptAt: undefined,
        updatedAt: args.now,
      });
      return { kind: "terminal" as const, state: claim.state };
    }
    const [revision, item] = await Promise.all([
      ctx.db.get(work.sourceRevisionId),
      ctx.db.get(work.sourceItemId),
    ]);
    if (
      !revision ||
      revision.spaceId !== work.spaceId ||
      !item ||
      item.spaceId !== work.spaceId
    ) {
      throw new Error("Inline work source chain is invalid");
    }
    await ctx.db.patch(work._id, {
      state: "running",
      attempts: claim.leaseEpoch,
      nextAttemptAt: claim.leaseExpiresAt,
      lastErrorCode: undefined,
      updatedAt: args.now,
    });
    return {
      kind: "claimed" as const,
      jobId: work.ingestJobId,
      principal: actorRef(job),
      leaseEpoch: claim.leaseEpoch,
      leaseToken: args.leaseToken,
      alreadyStaged: claim.state === "staged",
      text: revision.inlineText,
      title: item.title ?? "Untitled",
      docType: item.docType ?? "generic",
      capturedAt: revision.capturedAt,
    };
  } catch (error) {
    const code = boundedErrorCode(error);
    if (code !== "authorization_revoked") throw error;
    await markInlineAuthorizationRevoked(ctx, work, job, args.now);
    return { kind: "denied" as const };
  }
}

export function inlineRetryAt(attempts: number, now: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 6));
  return now + Math.min(60_000 * 2 ** exponent, INLINE_WORK_MAX_BACKOFF_MS);
}

export async function recordInlineWorkFailure(
  ctx: MutationCtx,
  args: {
    workId: Id<"inlineWork">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
    error: string;
  },
) {
  const { work, job } = await requireWorkChain(ctx, args.workId);
  if (job.state === "ready") {
    await ctx.db.patch(work._id, {
      state: "ready",
      nextAttemptAt: undefined,
      lastErrorCode: undefined,
      updatedAt: args.now,
    });
    return { state: "ready" as const };
  }
  if (!hasCurrentLease(job, args)) {
    return { state: "stale" as const };
  }
  const classifiedCode = boundedErrorCode(args.error);
  const code =
    classifiedCode === "authorization_revoked"
      ? "inline_worker_error"
      : classifiedCode;
  const retryable = code === "inline_worker_error";
  const nextAttemptAt = retryable
    ? inlineRetryAt(job.attempts, args.now)
    : undefined;
  try {
    const failed = await failJob(ctx, {
      principal: actorRef(job),
      jobId: work.ingestJobId,
      leaseEpoch: args.leaseEpoch,
      leaseToken: args.leaseToken,
      now: args.now,
      code,
      message: "Inline source processing failed",
      retryable,
      nextAttemptAt,
      needsReview: code === "invalid_staging",
    });
    const state =
      failed.state === "needs_review"
        ? "needs_review"
        : failed.state === "obsolete_generation"
          ? "obsolete_generation"
          : "failed";
    await ctx.db.patch(work._id, {
      state,
      attempts: job.attempts,
      nextAttemptAt: failed.retryable ? nextAttemptAt : undefined,
      lastErrorCode: code,
      updatedAt: args.now,
    });
    return { state };
  } catch (failureError) {
    if (boundedErrorCode(failureError) !== "authorization_revoked") {
      throw failureError;
    }
    await markInlineAuthorizationRevoked(ctx, work, job, args.now);
    return { state: "failed" as const };
  }
}

export async function syncInlineWorkState(
  ctx: MutationCtx,
  args: { workId: Id<"inlineWork">; now: number },
) {
  const { work, job } = await requireWorkChain(ctx, args.workId);
  await requireSourceAccountAccess(
    ctx,
    actorRef(job),
    work.sourceAccountId,
    "ingest",
  );
  const state =
    job.state === "ready"
      ? "ready"
      : job.state === "needs_review"
        ? "needs_review"
        : job.state === "obsolete_generation"
          ? "obsolete_generation"
          : job.state === "failed"
            ? "failed"
            : job.state === "processing" || job.state === "staged"
              ? "running"
              : "queued";
  await ctx.db.patch(work._id, {
    state,
    nextAttemptAt:
      state === "running"
        ? job.leaseExpiresAt
        : state === "queued"
          ? (job.nextAttemptAt ?? args.now)
          : state === "failed" && job.error?.retryable
            ? job.nextAttemptAt
            : undefined,
    updatedAt: args.now,
  });
  return { state };
}

export async function getInlineIngestResult(
  ctx: MutationCtx,
  args: { principal: PrincipalRef; workId: Id<"inlineWork"> },
): Promise<InlineIngestResult> {
  const { work, job } = await requireWorkChain(ctx, args.workId);
  await requireSourceAccountAccess(
    ctx,
    args.principal,
    work.sourceAccountId,
    "ingest",
  );
  const item = await ctx.db.get(work.sourceItemId);
  if (!item || item.spaceId !== work.spaceId) {
    throw new Error("Inline work source chain is invalid");
  }
  const documents = await ctx.db
    .query("documents")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", work.processingGenerationId),
    )
    .take(2);
  if (documents.length > 1) throw new Error("Inline document count is invalid");
  const document = documents[0];
  if (
    document &&
    (document.spaceId !== work.spaceId ||
      document.processingGenerationId !== work.processingGenerationId ||
      document.sourceItemId !== work.sourceItemId ||
      document.sourceRevisionId !== work.sourceRevisionId)
  ) {
    throw new Error("Inline document parent chain is invalid");
  }
  const isActive = item.activeGenerationId === work.processingGenerationId;
  const state =
    job.state === "ready"
      ? "ready"
      : work.state === "needs_review" || job.state === "needs_review"
        ? "needs_review"
        : work.state === "failed" ||
            work.state === "obsolete_generation" ||
            job.state === "failed" ||
            job.state === "obsolete_generation"
          ? "failed"
          : "queued";
  return {
    sourceItemId: work.sourceItemId,
    sourceRevisionId: work.sourceRevisionId,
    processingGenerationId: work.processingGenerationId,
    ingestJobId: work.ingestJobId,
    ...(document ? { documentId: document._id } : {}),
    desiredProcessingEpoch: item.desiredProcessingEpoch,
    isActive,
    state,
  };
}

/** Reserves a bounded set of due rows for cron dispatch. */
export async function reserveRecoverableInlineWork(
  ctx: MutationCtx,
  now: number,
): Promise<Id<"inlineWork">[]> {
  const candidates: Doc<"inlineWork">[] = [];
  for (const state of ["queued", "running", "failed"] as const) {
    const rows = await ctx.db
      .query("inlineWork")
      .withIndex("by_state_and_nextAttemptAt", (q) =>
        q
          .eq("state", state)
          .gt("nextAttemptAt", undefined)
          .lte("nextAttemptAt", now),
      )
      .take(INLINE_WORK_BATCH_SIZE);
    for (const row of rows) {
      if (row.nextAttemptAt !== undefined && row.nextAttemptAt <= now) {
        candidates.push(row);
      }
    }
  }
  candidates.sort(
    (left, right) =>
      (left.nextAttemptAt ?? 0) - (right.nextAttemptAt ?? 0) ||
      String(left._id).localeCompare(String(right._id)),
  );
  candidates.splice(INLINE_WORK_BATCH_SIZE);
  const authorized: Id<"inlineWork">[] = [];
  for (const row of candidates) {
    let job: Doc<"ingestJobs">;
    try {
      ({ job } = await requireWorkChain(ctx, row._id));
    } catch {
      await ctx.db.patch(row._id, {
        state: "needs_review",
        nextAttemptAt: undefined,
        lastErrorCode: "invalid_work_chain",
        updatedAt: now,
      });
      continue;
    }
    const terminalState =
      job.state === "ready"
        ? "ready"
        : job.state === "needs_review"
          ? "needs_review"
          : job.state === "obsolete_generation"
            ? "obsolete_generation"
            : job.state === "failed" && !job.error?.retryable
              ? "failed"
              : undefined;
    if (terminalState) {
      await ctx.db.patch(row._id, {
        state: terminalState,
        nextAttemptAt: undefined,
        lastErrorCode:
          terminalState === "ready" ? undefined : row.lastErrorCode,
        updatedAt: now,
      });
      continue;
    }
    try {
      await requireSourceAccountAccess(
        ctx,
        actorRef(job),
        row.sourceAccountId,
        "ingest",
      );
      await ctx.db.patch(row._id, {
        nextAttemptAt: now + INLINE_WORK_LEASE_MS,
        updatedAt: now,
      });
      authorized.push(row._id);
    } catch {
      await markInlineAuthorizationRevoked(ctx, row, job, now);
    }
  }
  return authorized;
}
