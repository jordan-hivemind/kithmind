import type { Pool } from "pg";

import { withKithTransaction } from "../schema.js";
import { workerCtx, type WorkerCtx } from "./db.js";

export * from "./auth.js";
export * from "./archivedDiscovery.js";
export * from "./archiveForget.js";
export * from "./assessment.js";
export * from "./cursor.js";
export * from "./db.js";
export * from "./digests.js";
export * from "./diagnostics.js";
export * from "./dispatch.js";
export * from "./discovery.js";
export * from "./entries.js";
export * from "./exhaustedWork.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./jobs.js";
export * from "./notReady.js";
export * from "./parsedJobs.js";
export * from "./profile.js";
export * from "./publication.js";
export * from "./providerOriginalForget.js";
export * from "./rateLimit.js";
export * from "./rows.js";
export * from "./scans.js";
export * from "./sourceRoots.js";
export * from "./status.js";

/**
 * Runs one worker operation with Convex-equivalent atomicity.
 *
 * All worker service functions accept a `WorkerCtx` and assume this boundary
 * owns the transaction. Keeping the boundary here prevents a route or daemon
 * caller from accidentally committing the individual SQL statements of one
 * operation separately.
 */
export async function withWorkerTransaction<T>(
  pool: Pool,
  work: (ctx: WorkerCtx) => Promise<T>,
  now = Date.now(),
): Promise<T> {
  return withKithTransaction(pool, (client) => work(workerCtx(client, now)));
}
