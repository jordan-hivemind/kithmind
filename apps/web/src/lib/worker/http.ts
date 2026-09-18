// The worker protocol's published status table.
//
// i7a repointed this from `@repo/db/convex/models/workers/protocol`, which was
// always a pure `export * from "@repo/worker-protocol/request"` (see that
// file's own comment), to the package it re-exported. i7b deleted
// `backendWorkerError`, which read the code off a `ConvexError`'s `data`
// envelope; the store's `workerProtocolErrorCode` is the only classifier left
// and `/api/worker` calls this table with what it returns.
import type { WorkerProtocolErrorCode } from "@repo/worker-protocol/request";

import { IngestHttpError } from "@/lib/ingest/http";

// Only published codes cross the boundary. Backend messages and arbitrary error
// data may contain source paths or implementation details.
const errors: Record<WorkerProtocolErrorCode, readonly [number, string]> = {
  not_authenticated: [401, "Not authenticated"],
  not_authorized: [403, "Not authorized"],
  invalid_request: [400, "Invalid worker request"],
  not_found: [404, "Source or work is not available"],
  source_unavailable: [409, "Source is not available for worker operations"],
  request_conflict: [409, "Request ID conflicts with a different request"],
  scan_conflict: [409, "Scan state has changed"],
  scan_not_ready: [409, "Scan is not ready for this operation"],
  identity_review_required: [409, "Source identity requires operator review"],
  rate_limited: [429, "Worker rate limit exceeded"],
  reservation_expired: [409, "Reservation has expired"],
  stale_observation: [409, "A newer source observation exists"],
  desired_processing_epoch_conflict: [
    409,
    "Desired processing epoch has changed",
  ],
  lease_conflict: [409, "Work lease is no longer current"],
};

/**
 * One published code, as its published status and message.
 *
 * `/api/worker` classifies its refusal with `@repo/kith-store`'s
 * `workerProtocolErrorCode` over this closed code set and then reaches this
 * table, so the route and the store's own adapter answer one protocol from one
 * mapping rather than from two that could drift.
 */
export function workerErrorForCode(
  code: WorkerProtocolErrorCode,
): IngestHttpError {
  const [status, message] = errors[code];
  return new IngestHttpError(status, code, message);
}
