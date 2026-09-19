// P2-104d. A `WorkerTransport` that calls the real dispatch function in this
// process instead of crossing HTTP.
//
// The HTTP adapter turns an unexpected server error into `worker_failed` with
// a fixed message, which is right for a worker and useless for a test: a
// failing rehearsal said only that something threw. This keeps the published
// protocol codes, which the pipeline depends on for its retry and replay
// decisions, and rethrows anything else with its stack intact.
//
// Credential, space, source and lease fencing are unchanged: the principal is
// fixed at construction, exactly as authentication would have resolved it, and
// every handler still checks it against the space and source it is given.

import {
  dispatchWorkerRequest,
  workerProtocolErrorCode,
} from "../../dist/workers/index.js";

/**
 * @param pool a kith pool
 * @param principal `{ userId, credentialId }`
 * @param now optional fixed clock
 */
export function inProcessWorkerTransport(pool, principal, now) {
  return {
    async call(request) {
      try {
        return await dispatchWorkerRequest(
          pool,
          principal,
          request,
          now === undefined ? Date.now() : now,
        );
      } catch (error) {
        const code = workerProtocolErrorCode(error);
        // A refused operation is the one thing a failing rehearsal always
        // needs and never has: the pass reports the code, not where it came
        // from. Off by default; set KITH_WORKER_TRACE=1 to see it.
        if (process.env.KITH_WORKER_TRACE === "1") {
          process.stderr.write(
            `${JSON.stringify({ operation: request.operation, code: code ?? "unexpected", message: `${error}` })}\n`,
          );
        }
        if (code) return { error: { code } };
        throw error;
      }
    },
  };
}
