import { ConvexError } from "convex/values";

import {
  parseWorkerProtocolErrorData,
  type WorkerProtocolErrorCode,
  type WorkerProtocolErrorData,
  WorkerProtocolParseError,
} from "./protocol";

export function workerProtocolError(
  code: WorkerProtocolErrorCode,
): ConvexError<WorkerProtocolErrorData> {
  return new ConvexError({ type: "worker_protocol_error", code });
}

function errorData(error: unknown): unknown {
  return typeof error === "object" && error !== null && "data" in error
    ? error.data
    : undefined;
}

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

export function rethrowWorkerProtocolError(error: unknown): never {
  const code = workerProtocolErrorCode(error);
  throw code ? workerProtocolError(code) : error;
}
