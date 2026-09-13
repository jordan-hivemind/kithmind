import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWorkerProtocolErrorData,
  parseWorkerRequest,
  WorkerProtocolParseError,
} from "@repo/worker-protocol/request";

const source = {
  protocolVersion: 1,
  spaceId: "j1234567890123456789012345678901",
  sourceAccountId: "j1234567890123456789012345678902",
};

test("the request subpath is a runtime export with the unchanged strict parser", () => {
  assert.deepEqual(
    parseWorkerRequest({ ...source, operation: "source.status" }),
    { ...source, operation: "source.status" },
  );
  assert.throws(
    () =>
      parseWorkerRequest({
        ...source,
        operation: "source.status",
        unexpected: true,
      }),
    WorkerProtocolParseError,
  );
  assert.deepEqual(
    parseWorkerProtocolErrorData({
      type: "worker_protocol_error",
      code: "lease_conflict",
    }),
    { type: "worker_protocol_error", code: "lease_conflict" },
  );
});
