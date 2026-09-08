import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { PrincipalRef } from "../../lib/spaces";
import { sha256Utf8 } from "../provenance/model";
import { loadProviderOriginalReference } from "../provenance/providerOriginals";
import { requireWorkerSourceAccount } from "./auth";
import { workerProtocolError } from "./errors";
import { consumeWorkerMutationRateLimit } from "./rateLimit";
import type {
  WorkerProviderOriginalAckDetachResult,
  WorkerProviderOriginalDetachAckSummary,
  WorkerProviderOriginalForgetTarget,
  WorkerProviderOriginalForgetTargetsResult,
  WorkerRequest,
} from "./protocol";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type LoadedSource = Awaited<ReturnType<typeof requireWorkerSourceAccount>>;

async function requireForgettingItem(
  ctx: ReadCtx,
  principal: PrincipalRef,
  request: {
    spaceId: string;
    sourceAccountId: string;
    sourceItemId: string;
    expectedForgetEpoch: number;
  },
): Promise<{ source: LoadedSource; item: Doc<"sourceItems"> }> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const sourceItemId = ctx.db.normalizeId("sourceItems", request.sourceItemId);
  if (!sourceItemId) throw workerProtocolError("invalid_request");
  const item = await ctx.db.get(sourceItemId);
  if (
    !item ||
    item.spaceId !== source.spaceId ||
    item.sourceAccountId !== source.account._id
  )
    throw workerProtocolError("not_found");
  if (
    item.lifecycle !== "forgetting" ||
    item.desiredProcessingEpoch !== request.expectedForgetEpoch
  )
    throw workerProtocolError("stale_observation");
  if (
    item.externalId === undefined ||
    (await sha256Utf8(item.externalId)) !== item.externalIdHash
  )
    throw workerProtocolError("scan_conflict");
  return { source, item };
}

function ackSummary(
  ack: Doc<"sourceProviderOriginalDetachAcks">,
): WorkerProviderOriginalDetachAckSummary {
  if (
    ack.ackVersion !== "provider_original_detach_ack_v1" ||
    ack.locatorAbsenceAuthority !== "worker_asserted_live_repository_absence" ||
    ack.retentionDisclosure !== "provider_retained_deleted_history_possible" ||
    ack.providerSourceOutcome !== "retained_unchanged"
  )
    throw workerProtocolError("scan_conflict");
  return {
    detachId: ack.detachId,
    referenceId: ack.referenceId,
    forgetEpoch: ack.forgetEpoch,
    referenceOutcome: ack.referenceOutcome,
    locatorBundleOutcome: ack.locatorBundleOutcome,
    locatorAbsenceAuthority: ack.locatorAbsenceAuthority,
    retentionDisclosure: ack.retentionDisclosure,
    providerSourceOutcome: ack.providerSourceOutcome,
    completedAt: ack.completedAt,
  };
}

async function requireReferenceChain(
  ctx: ReadCtx,
  source: LoadedSource,
  item: Doc<"sourceItems">,
  reference: Doc<"sourceProviderOriginalReferences">,
) {
  const revision = await ctx.db.get(reference.sourceRevisionId);
  if (
    reference.spaceId !== source.spaceId ||
    reference.sourceAccountId !== source.account._id ||
    reference.sourceItemId !== item._id ||
    !revision ||
    revision.spaceId !== source.spaceId ||
    revision.sourceItemId !== item._id ||
    revision.contentHash !== reference.sourceContentHash ||
    revision.byteLength !== reference.sourceByteLength ||
    reference.referenceVersion !== "provider_original_v1" ||
    reference.providerKind !== "dropbox_v1" ||
    reference.verificationAuthority !== "worker_asserted" ||
    !UUID.test(reference.locatorBindingId) ||
    !SHA256.test(reference.referenceFingerprint) ||
    !SHA256.test(reference.locatorRepositoryId) ||
    !SHA256.test(reference.locatorSnapshotId) ||
    !SHA256.test(reference.locatorCiphertextHash) ||
    !OBJECT_NAME.test(reference.locatorObjectName) ||
    !Number.isSafeInteger(reference.locatorCiphertextByteLength) ||
    reference.locatorCiphertextByteLength < 1
  )
    throw workerProtocolError("scan_conflict");
  try {
    await loadProviderOriginalReference(ctx, {
      referenceId: reference._id,
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      sourceItemId: item._id,
      sourceRevisionId: reference.sourceRevisionId,
      expectedSourceContentHash: revision.contentHash,
      expectedSourceByteLength: revision.byteLength,
    });
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  return reference;
}

async function loadAck(
  ctx: ReadCtx,
  referenceId: Id<"sourceProviderOriginalReferences">,
  forgetEpoch: number,
) {
  const rows = await ctx.db
    .query("sourceProviderOriginalDetachAcks")
    .withIndex("by_referenceId_and_forgetEpoch", (q) =>
      q.eq("referenceId", referenceId).eq("forgetEpoch", forgetEpoch),
    )
    .take(2);
  if (rows.length > 1) throw workerProtocolError("scan_conflict");
  return rows[0] ?? null;
}

function target(
  reference: Doc<"sourceProviderOriginalReferences">,
  forgetEpoch: number,
  ack: Doc<"sourceProviderOriginalDetachAcks"> | null,
): WorkerProviderOriginalForgetTarget {
  return {
    referenceId: reference._id,
    referenceFingerprint: reference.referenceFingerprint,
    locatorBindingId: reference.locatorBindingId,
    locatorRepositoryId: reference.locatorRepositoryId,
    locatorSnapshotId: reference.locatorSnapshotId,
    locatorObjectName: reference.locatorObjectName,
    locatorCiphertextHash: reference.locatorCiphertextHash,
    locatorCiphertextByteLength: reference.locatorCiphertextByteLength,
    forgetEpoch,
    ...(ack ? { ack: ackSummary(ack) } : {}),
  };
}

export async function getProviderOriginalForgetTargets(
  ctx: QueryCtx,
  principal: PrincipalRef,
  request: Extract<
    WorkerRequest,
    { operation: "providerOriginal.forgetTargets" }
  >,
): Promise<WorkerProviderOriginalForgetTargetsResult> {
  const { source, item } = await requireForgettingItem(ctx, principal, request);
  const page = await ctx.db
    .query("sourceProviderOriginalReferences")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .paginate({
      cursor: request.paginationOpts.cursor,
      numItems: request.paginationOpts.numItems,
    });
  const targets: WorkerProviderOriginalForgetTarget[] = [];
  for (const reference of page.page) {
    await requireReferenceChain(ctx, source, item, reference);
    const ack = await loadAck(ctx, reference._id, request.expectedForgetEpoch);
    targets.push(target(reference, request.expectedForgetEpoch, ack));
  }
  return {
    operation: "providerOriginal.forgetTargets",
    sourceItemId: item._id,
    sourceExternalIdHash: item.externalIdHash,
    forgetEpoch: request.expectedForgetEpoch,
    targets,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

async function requestDigest(
  request: Extract<WorkerRequest, { operation: "providerOriginal.ackDetach" }>,
) {
  return sha256Utf8(
    `provider-original-detach-ack:v1\0${JSON.stringify([
      request.spaceId,
      request.sourceAccountId,
      request.requestId,
      request.sourceItemId,
      request.expectedForgetEpoch,
      request.detachId,
      request.referenceId,
      request.locatorBindingId,
      request.locatorRepositoryId,
      request.locatorSnapshotId,
      request.locatorObjectName,
      request.referenceOutcome,
      request.locatorBundleOutcome,
      request.locatorAbsenceAuthority,
      request.retentionDisclosure,
      request.providerSourceOutcome,
    ])}`,
  );
}

function sameAck(
  ack: Doc<"sourceProviderOriginalDetachAcks">,
  request: Extract<WorkerRequest, { operation: "providerOriginal.ackDetach" }>,
  source: LoadedSource,
  item: Doc<"sourceItems">,
  digest: string,
) {
  return (
    ack.spaceId === source.spaceId &&
    ack.sourceAccountId === source.account._id &&
    ack.sourceItemId === item._id &&
    ack.referenceId === request.referenceId &&
    ack.forgetEpoch === request.expectedForgetEpoch &&
    ack.detachId === request.detachId &&
    ack.requestId === request.requestId &&
    ack.requestDigest === digest &&
    ack.locatorBindingId === request.locatorBindingId &&
    ack.locatorRepositoryId === request.locatorRepositoryId &&
    ack.locatorSnapshotId === request.locatorSnapshotId &&
    ack.locatorObjectName === request.locatorObjectName &&
    ack.referenceOutcome === request.referenceOutcome &&
    ack.locatorBundleOutcome === request.locatorBundleOutcome &&
    ack.locatorAbsenceAuthority === request.locatorAbsenceAuthority &&
    ack.retentionDisclosure === request.retentionDisclosure &&
    ack.providerSourceOutcome === request.providerSourceOutcome &&
    ack.actorUserId === source.principal.userId &&
    ack.actorCredentialId === source.principal.credentialId
  );
}

export async function acknowledgeProviderOriginalDetach(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "providerOriginal.ackDetach" }>,
  now: number,
): Promise<WorkerProviderOriginalAckDetachResult> {
  const { source, item } = await requireForgettingItem(ctx, principal, request);
  const digest = await requestDigest(request);
  const referenceId = ctx.db.normalizeId(
    "sourceProviderOriginalReferences",
    request.referenceId,
  );
  if (!referenceId) throw workerProtocolError("invalid_request");
  const [priorByDetach, priorByRequest, priorByReference] = await Promise.all([
    ctx.db
      .query("sourceProviderOriginalDetachAcks")
      .withIndex("by_sourceAccountId_and_detachId", (q) =>
        q
          .eq("sourceAccountId", source.account._id)
          .eq("detachId", request.detachId),
      )
      .take(2),
    ctx.db
      .query("sourceProviderOriginalDetachAcks")
      .withIndex("by_sourceAccountId_and_requestId", (q) =>
        q
          .eq("sourceAccountId", source.account._id)
          .eq("requestId", request.requestId),
      )
      .take(2),
    ctx.db
      .query("sourceProviderOriginalDetachAcks")
      .withIndex("by_referenceId_and_forgetEpoch", (q) =>
        q
          .eq("referenceId", referenceId)
          .eq("forgetEpoch", request.expectedForgetEpoch),
      )
      .take(2),
  ]);
  if (
    priorByDetach.length > 1 ||
    priorByRequest.length > 1 ||
    priorByReference.length > 1
  )
    throw workerProtocolError("scan_conflict");
  const prior = priorByDetach[0] ?? priorByRequest[0] ?? priorByReference[0];
  if (prior) {
    if (
      priorByDetach[0]?._id !== prior._id ||
      priorByRequest[0]?._id !== prior._id ||
      priorByReference[0]?._id !== prior._id ||
      !sameAck(prior, request, source, item, digest)
    )
      throw workerProtocolError("request_conflict");
    return {
      operation: "providerOriginal.ackDetach",
      ...ackSummary(prior),
      reused: true,
    };
  }
  const reference = await ctx.db.get(referenceId);
  if (
    !reference ||
    reference.spaceId !== source.spaceId ||
    reference.sourceAccountId !== source.account._id ||
    reference.sourceItemId !== item._id ||
    reference.locatorBindingId !== request.locatorBindingId ||
    reference.locatorRepositoryId !== request.locatorRepositoryId ||
    reference.locatorSnapshotId !== request.locatorSnapshotId ||
    reference.locatorObjectName !== request.locatorObjectName
  )
    throw workerProtocolError("stale_observation");
  await requireReferenceChain(ctx, source, item, reference);
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const id = await ctx.db.insert("sourceProviderOriginalDetachAcks", {
    ackVersion: "provider_original_detach_ack_v1",
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: item._id,
    sourceRevisionId: reference.sourceRevisionId,
    referenceId: reference._id,
    forgetEpoch: request.expectedForgetEpoch,
    detachId: request.detachId,
    requestId: request.requestId,
    requestDigest: digest,
    referenceFingerprint: reference.referenceFingerprint,
    locatorBindingId: reference.locatorBindingId,
    locatorRepositoryId: reference.locatorRepositoryId,
    locatorSnapshotId: reference.locatorSnapshotId,
    locatorObjectName: reference.locatorObjectName,
    referenceOutcome: request.referenceOutcome,
    locatorBundleOutcome: request.locatorBundleOutcome,
    locatorAbsenceAuthority: request.locatorAbsenceAuthority,
    retentionDisclosure: request.retentionDisclosure,
    providerSourceOutcome: request.providerSourceOutcome,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    completedAt: now,
  });
  const ack = await ctx.db.get(id);
  if (!ack) throw workerProtocolError("scan_conflict");
  return {
    operation: "providerOriginal.ackDetach",
    ...ackSummary(ack),
    reused: false,
  };
}
