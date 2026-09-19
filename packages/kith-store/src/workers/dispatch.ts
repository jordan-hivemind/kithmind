import { randomBytes } from "node:crypto";

import {
  parseWorkerRequest,
  type WorkerRequest,
  type WorkerResult,
} from "@repo/worker-protocol/request";
import type { Pool } from "pg";

import type { PrincipalRef } from "../identity/index.js";
import { withKithTransaction } from "../schema.js";
import {
  acknowledgeArchiveDeletion,
  getArchiveForgetTargets,
} from "./archiveForget.js";
import {
  advanceProcessingAssessment,
  beginProcessingAssessment,
} from "./assessment.js";
import {
  admitArchivedDiscovery,
  failArchivedDiscovery,
  lookupArchivedAdmission,
  preflightArchivedDiscovery,
  reserveArchivedDiscovery,
} from "./archivedDiscovery.js";
import {
  getWorkerDiagnosticsStatus,
  recordWorkerHeartbeat,
  recordWorkerPassOutcome,
} from "./diagnostics.js";
import { admitDiscoveryUtf8, reserveDiscoveryWork } from "./discovery.js";
import {
  activateProcessingJob,
  failProcessingJob,
  renewProcessingJob,
  reserveProcessingJobs,
  stageProcessingUtf8,
} from "./jobs.js";
import {
  activateParsedJob,
  beginParsedStage,
  failParsedJob,
  renewParsedJob,
  reserveParsedJobs,
  sealParsedStage,
  stageParsedBatch,
} from "./parsedJobs.js";
import {
  acknowledgeProviderOriginalDetach,
  getProviderOriginalForgetTargets,
} from "./providerOriginalForget.js";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  getWorkerInventoryPage,
  reconcileWorkerScan,
  sealWorkerScan,
} from "./scans.js";
import {
  getWorkerSourceRoots,
  recordWorkerSourceRootReport,
} from "./sourceRoots.js";
import { getWorkerSourceStatus } from "./status.js";
import { workerCtx } from "./db.js";

function leaseTokens(count: number): string[] {
  return Array.from({ length: count }, () => randomBytes(32).toString("hex"));
}

/** Dispatches one already-authenticated worker request in one SQL transaction. */
export async function dispatchWorkerRequest(
  pool: Pool,
  principal: PrincipalRef,
  value: unknown,
  now = Date.now(),
): Promise<WorkerResult> {
  const request = parseWorkerRequest(value);
  return withKithTransaction(pool, async (client): Promise<WorkerResult> => {
    const ctx = workerCtx(client, now);
    switch (request.operation) {
      case "source.status":
        return getWorkerSourceStatus(ctx, principal, request);
      case "source.roots":
        return getWorkerSourceRoots(ctx, principal, request);
      case "source.rootReport":
        return recordWorkerSourceRootReport(ctx, principal, request);
      case "diagnostics.status":
        return getWorkerDiagnosticsStatus(ctx, principal, request);
      case "diagnostics.heartbeat":
        return recordWorkerHeartbeat(ctx, principal, request);
      case "diagnostics.passOutcome":
        return recordWorkerPassOutcome(ctx, principal, request);
      case "archive.forgetTargets":
        return getArchiveForgetTargets(ctx, principal, request);
      case "archive.ackDeletion":
        return acknowledgeArchiveDeletion(ctx, principal, request);
      case "providerOriginal.forgetTargets":
        return getProviderOriginalForgetTargets(ctx, principal, request);
      case "providerOriginal.ackDetach":
        return acknowledgeProviderOriginalDetach(ctx, principal, request);
      case "source.inventoryPage":
        return getWorkerInventoryPage(ctx, principal, request);
      case "scan.begin":
        return beginWorkerScan(ctx, principal, request);
      case "scan.appendPage":
        return appendWorkerScanPage(ctx, principal, request);
      case "scan.seal":
        return sealWorkerScan(ctx, principal, request);
      case "scan.reconcile":
        return reconcileWorkerScan(ctx, principal, request);
      case "discovery.reserve":
        return reserveDiscoveryWork(
          ctx,
          principal,
          request,
          leaseTokens(request.maxItems),
        );
      case "discovery.admitUtf8":
        return admitDiscoveryUtf8(ctx, principal, request);
      case "discovery.preflightArchived":
        return preflightArchivedDiscovery(ctx, principal, request);
      case "discovery.failArchived":
        return failArchivedDiscovery(ctx, principal, request);
      case "discovery.reserveArchived":
        return reserveArchivedDiscovery(
          ctx,
          principal,
          request,
          leaseTokens(1)[0]!,
        );
      case "discovery.lookupArchivedAdmission":
        return lookupArchivedAdmission(ctx, principal, request);
      case "discovery.admitArchived":
        return admitArchivedDiscovery(ctx, principal, request);
      case "jobs.reserve":
        return reserveProcessingJobs(
          ctx,
          principal,
          request,
          leaseTokens(request.maxItems),
        );
      case "jobs.renew":
        return renewProcessingJob(ctx, principal, request);
      case "jobs.stageUtf8":
        return stageProcessingUtf8(ctx, principal, request);
      case "jobs.activate":
        return activateProcessingJob(ctx, principal, request);
      case "jobs.fail":
        return failProcessingJob(ctx, principal, request);
      case "jobs.reserveParsed":
        return reserveParsedJobs(
          ctx,
          principal,
          request,
          leaseTokens(request.maxItems),
        );
      case "jobs.renewParsed":
        return renewParsedJob(ctx, principal, request);
      case "jobs.failParsed":
        return failParsedJob(ctx, principal, request);
      case "jobs.stageParsedBegin":
        return beginParsedStage(ctx, principal, request);
      case "jobs.stageParsedBatch":
        return stageParsedBatch(ctx, principal, request);
      case "jobs.stageParsedSeal":
        return sealParsedStage(ctx, principal, request);
      case "jobs.activateParsed":
        return activateParsedJob(ctx, principal, request);
      case "processing.assessBegin":
        return beginProcessingAssessment(ctx, principal, request);
      case "processing.assessPage":
        return advanceProcessingAssessment(ctx, principal, request);
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  });
}

export type { WorkerRequest };
