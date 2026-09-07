import {
  parseWorkerProtocolErrorData,
  type WorkerProtocolErrorCode,
} from "@repo/db/convex/models/workers/protocol";

import { IngestHttpError } from "@/lib/ingest/http";

// Only published codes cross the boundary. Convex messages and arbitrary error
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

export function backendWorkerError(error: unknown): IngestHttpError {
  const data = parseWorkerProtocolErrorData(
    typeof error === "object" && error !== null && "data" in error
      ? error.data
      : undefined,
  );
  if (!data) {
    return new IngestHttpError(500, "worker_failed", "Worker operation failed");
  }
  const [status, message] = errors[data.code];
  return new IngestHttpError(status, data.code, message);
}
