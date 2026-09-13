// The wire contract's error codes, unchanged, on the Postgres side.
//
// `packages/pipeline/src/transport.ts` holds a closed `ERROR_CODES` set and
// refuses a response carrying anything else, so the fourteen codes are the
// contract and not an implementation detail. They are imported from
// `@repo/worker-protocol/request` rather than retyped here: that module is the
// one the Convex route also validates against (it moved out of
// `packages/convex/convex/models/workers/protocol.ts` for this row), so the two
// surfaces cannot drift into disagreeing about which codes exist.
//
// A code is deliberately uninformative. `not_found` covers "no such row", "a row
// in another space" and "a row this credential did not create", because a worker
// must not be able to enumerate another space's items by watching which failure
// comes back. That is the same rule the identity surface applies to
// `Space not found`, and it is why `ProofError` and `IdentityError` are both
// translated to a code at the service boundary rather than reaching a client.

import {
  parseWorkerProtocolErrorData,
  WorkerProtocolParseError,
  type WorkerProtocolErrorCode,
} from "@repo/worker-protocol/request";

export type { WorkerProtocolErrorCode };

/**
 * The one error this surface throws outward. `code` is what the route serializes
 * and the pipeline client branches on; the message exists for a log line and is
 * never part of the contract.
 */
export class WorkerProtocolError extends Error {
  readonly data: {
    type: "worker_protocol_error";
    code: WorkerProtocolErrorCode;
  };

  constructor(readonly code: WorkerProtocolErrorCode) {
    super(`worker_protocol_error:${code}`);
    this.name = "WorkerProtocolError";
    this.data = { type: "worker_protocol_error", code };
  }
}

/** `throw workerProtocolError("scan_conflict")`, the Convex spelling kept. */
export function workerProtocolError(code: WorkerProtocolErrorCode): never {
  throw new WorkerProtocolError(code);
}

function errorData(error: unknown): unknown {
  return typeof error === "object" && error !== null && "data" in error
    ? (error as { data: unknown }).data
    : undefined;
}

/**
 * The code `error` carries, or undefined when it carries none.
 *
 * Ported from `models/workers/errors.ts` including its two non-structured cases,
 * because both are reachable here too: a parse failure from the shared request
 * validator is `invalid_request`, and the identity surface's bare
 * `new Error("Not authenticated")` is `not_authenticated`.
 */
export function workerProtocolErrorCode(
  error: unknown,
): WorkerProtocolErrorCode | undefined {
  const structured = parseWorkerProtocolErrorData(errorData(error));
  if (structured) return structured.code;
  if (error instanceof WorkerProtocolParseError) return "invalid_request";
  if (error instanceof Error && error.message === "Not authenticated") {
    return "not_authenticated";
  }
  return undefined;
}

/**
 * Rethrows `error` as a protocol error when it is one, unchanged otherwise.
 *
 * Unchanged matters: an unexpected failure must not be laundered into a
 * contract code a worker will retry against. A serialization failure in
 * particular has to reach `withKithTransaction`'s retry as itself.
 */
export function rethrowWorkerProtocolError(error: unknown): never {
  const code = workerProtocolErrorCode(error);
  if (code) throw new WorkerProtocolError(code);
  throw error;
}

/** Keep database aborts visible to the transaction boundary. */
export function isWorkerTransactionAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "40001" || error.code === "40P01")
  );
}
