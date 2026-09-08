import { v } from "convex/values";

import { internalMutation, internalQuery } from "../../_generated/server";
import { principalRefValidator } from "../apiKeys/validators";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  getWorkerInventoryPage,
  getWorkerSourceStatus,
  reconcileWorkerScan,
  sealWorkerScan,
} from "./model";
import { admitDiscoveryUtf8, reserveDiscoveryWork } from "./discovery";
import {
  admitArchivedDiscovery,
  lookupArchivedAdmission,
  preflightArchivedDiscovery,
  reserveArchivedDiscovery,
} from "./archivedDiscovery";
import {
  activateProcessingJob,
  beginProcessingStage,
  completeProcessingStage,
  failProcessingJob,
  renewProcessingJob,
  reserveProcessingJobs,
  stageProcessingChunkBatch,
  stageProcessingDocument,
  stageProcessingPage,
  stageProcessingSpanBatch,
  stageProcessingText,
} from "./jobs";
import {
  beginParsedStage,
  activateParsedJob,
  failParsedJob,
  renewParsedJob,
  reserveParsedJobs,
  sealParsedStage,
  stageParsedBatch,
} from "./parsedJobs";
import { parseWorkerRequest, type WorkerRequest } from "./protocol";
import {
  advanceProcessingAssessment,
  beginProcessingAssessment,
} from "./assessment";
import {
  acknowledgeArchiveDeletion,
  getArchiveForgetTargets,
} from "./archiveForget";
import {
  getWorkerDiagnosticsStatus,
  recordWorkerHeartbeat,
} from "../diagnostics/model";

function operation<T extends WorkerRequest["operation"]>(
  value: unknown,
  expected: T,
): Extract<WorkerRequest, { operation: T }> {
  const request = parseWorkerRequest(value);
  if (request.operation !== expected)
    throw new Error("Invalid worker operation");
  return request as Extract<WorkerRequest, { operation: T }>;
}

export const sourceStatus = internalQuery({
  args: { principal: principalRefValidator, request: v.any(), now: v.number() },
  handler: async (ctx, args) =>
    await getWorkerSourceStatus(
      ctx,
      args.principal,
      operation(args.request, "source.status"),
      args.now,
    ),
});

export const diagnosticsStatus = internalQuery({
  args: { principal: principalRefValidator, request: v.any(), now: v.number() },
  handler: async (ctx, args) =>
    await getWorkerDiagnosticsStatus(
      ctx,
      args.principal,
      operation(args.request, "diagnostics.status"),
      args.now,
    ),
});

export const diagnosticsHeartbeat = internalMutation({
  args: { principal: principalRefValidator, request: v.any(), now: v.number() },
  handler: async (ctx, args) =>
    await recordWorkerHeartbeat(
      ctx,
      args.principal,
      operation(args.request, "diagnostics.heartbeat"),
      args.now,
    ),
});

export const archiveForgetTargets = internalQuery({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await getArchiveForgetTargets(
      ctx,
      args.principal,
      operation(args.request, "archive.forgetTargets"),
    ),
});

export const archiveAckDeletion = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await acknowledgeArchiveDeletion(
      ctx,
      args.principal,
      operation(args.request, "archive.ackDeletion"),
      Date.now(),
    ),
});

export const sourceInventoryPage = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await getWorkerInventoryPage(
      ctx,
      args.principal,
      operation(args.request, "source.inventoryPage"),
      Date.now(),
    ),
});

export const scanBegin = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await beginWorkerScan(
      ctx,
      args.principal,
      operation(args.request, "scan.begin"),
      Date.now(),
    ),
});

export const scanAppendPage = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await appendWorkerScanPage(
      ctx,
      args.principal,
      operation(args.request, "scan.appendPage"),
      Date.now(),
    ),
});

export const scanSeal = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await sealWorkerScan(
      ctx,
      args.principal,
      operation(args.request, "scan.seal"),
      Date.now(),
    ),
});

export const scanReconcile = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await reconcileWorkerScan(
      ctx,
      args.principal,
      operation(args.request, "scan.reconcile"),
      Date.now(),
    ),
});

export const discoveryReserve = internalMutation({
  args: {
    principal: principalRefValidator,
    request: v.any(),
    tokens: v.array(v.string()),
  },
  handler: async (ctx, args) =>
    await reserveDiscoveryWork(
      ctx,
      args.principal,
      operation(args.request, "discovery.reserve"),
      args.tokens,
      Date.now(),
    ),
});

export const discoveryAdmitUtf8 = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await admitDiscoveryUtf8(
      ctx,
      args.principal,
      operation(args.request, "discovery.admitUtf8"),
      Date.now(),
    ),
});

export const discoveryPreflightArchived = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await preflightArchivedDiscovery(
      ctx,
      args.principal,
      operation(args.request, "discovery.preflightArchived"),
      Date.now(),
    ),
});

export const discoveryReserveArchived = internalMutation({
  args: {
    principal: principalRefValidator,
    request: v.any(),
    leaseToken: v.string(),
  },
  handler: async (ctx, args) =>
    await reserveArchivedDiscovery(
      ctx,
      args.principal,
      operation(args.request, "discovery.reserveArchived"),
      args.leaseToken,
      Date.now(),
    ),
});

export const discoveryLookupArchivedAdmission = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await lookupArchivedAdmission(
      ctx,
      args.principal,
      operation(args.request, "discovery.lookupArchivedAdmission"),
    ),
});

export const discoveryAdmitArchived = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await admitArchivedDiscovery(
      ctx,
      args.principal,
      operation(args.request, "discovery.admitArchived"),
      Date.now(),
    ),
});

export const jobsReserve = internalMutation({
  args: {
    principal: principalRefValidator,
    request: v.any(),
    tokens: v.array(v.string()),
  },
  handler: async (ctx, args) =>
    await reserveProcessingJobs(
      ctx,
      args.principal,
      operation(args.request, "jobs.reserve"),
      args.tokens,
      Date.now(),
    ),
});

export const jobsRenew = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await renewProcessingJob(
      ctx,
      args.principal,
      operation(args.request, "jobs.renew"),
      Date.now(),
    ),
});

export const jobsStageBegin = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await beginProcessingStage(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageUtf8"),
      Date.now(),
    ),
});

export const jobsStageText = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await stageProcessingText(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageUtf8"),
      Date.now(),
    ),
});

export const jobsStagePage = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await stageProcessingPage(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageUtf8"),
      Date.now(),
    ),
});

export const jobsStageSpans = internalMutation({
  args: {
    principal: principalRefValidator,
    request: v.any(),
    offset: v.number(),
  },
  handler: async (ctx, args) =>
    await stageProcessingSpanBatch(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageUtf8"),
      args.offset,
      Date.now(),
    ),
});

export const jobsStageDocument = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await stageProcessingDocument(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageUtf8"),
      Date.now(),
    ),
});

export const jobsStageChunks = internalMutation({
  args: {
    principal: principalRefValidator,
    request: v.any(),
    offset: v.number(),
  },
  handler: async (ctx, args) =>
    await stageProcessingChunkBatch(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageUtf8"),
      args.offset,
      Date.now(),
    ),
});

export const jobsStageComplete = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await completeProcessingStage(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageUtf8"),
      Date.now(),
    ),
});

export const jobsActivate = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await activateProcessingJob(
      ctx,
      args.principal,
      operation(args.request, "jobs.activate"),
      Date.now(),
    ),
});

export const jobsFail = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await failProcessingJob(
      ctx,
      args.principal,
      operation(args.request, "jobs.fail"),
      Date.now(),
    ),
});

export const jobsReserveParsed = internalMutation({
  args: {
    principal: principalRefValidator,
    request: v.any(),
    tokens: v.array(v.string()),
  },
  handler: async (ctx, args) =>
    await reserveParsedJobs(
      ctx,
      args.principal,
      operation(args.request, "jobs.reserveParsed"),
      args.tokens,
      Date.now(),
    ),
});

export const jobsRenewParsed = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await renewParsedJob(
      ctx,
      args.principal,
      operation(args.request, "jobs.renewParsed"),
      Date.now(),
    ),
});

export const jobsFailParsed = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await failParsedJob(
      ctx,
      args.principal,
      operation(args.request, "jobs.failParsed"),
      Date.now(),
    ),
});

export const jobsStageParsedBegin = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await beginParsedStage(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageParsedBegin"),
      Date.now(),
    ),
});

export const jobsStageParsedBatch = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await stageParsedBatch(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageParsedBatch"),
      Date.now(),
    ),
});

export const jobsStageParsedSeal = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await sealParsedStage(
      ctx,
      args.principal,
      operation(args.request, "jobs.stageParsedSeal"),
      Date.now(),
    ),
});

export const jobsActivateParsed = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await activateParsedJob(
      ctx,
      args.principal,
      operation(args.request, "jobs.activateParsed"),
      Date.now(),
    ),
});

export const processingAssessBegin = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await beginProcessingAssessment(
      ctx,
      args.principal,
      operation(args.request, "processing.assessBegin"),
      Date.now(),
    ),
});

export const processingAssessPage = internalMutation({
  args: { principal: principalRefValidator, request: v.any() },
  handler: async (ctx, args) =>
    await advanceProcessingAssessment(
      ctx,
      args.principal,
      operation(args.request, "processing.assessPage"),
      Date.now(),
    ),
});
