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

// ADM-4b. The two source-root operations, validated the way every other
// operation is: exact keys, a closed state and bounded sizes.
test("source.roots takes the envelope and nothing else", () => {
  assert.deepEqual(
    parseWorkerRequest({ ...source, operation: "source.roots" }),
    { ...source, operation: "source.roots" },
  );
  assert.throws(
    () =>
      parseWorkerRequest({
        ...source,
        operation: "source.roots",
        sourceRootId: "j1234567890123456789012345678903",
      }),
    WorkerProtocolParseError,
  );
});

test("source.rootReport takes a closed state and a bounded count", () => {
  const report = {
    ...source,
    operation: "source.rootReport",
    sourceRootId: "j1234567890123456789012345678903",
    observedAt: 1_758_196_800_000,
    itemCount: 12,
    state: "ok",
  };
  assert.deepEqual(parseWorkerRequest(report), report);
  assert.deepEqual(
    parseWorkerRequest({ ...report, providerFolderId: "folder-9" }),
    { ...report, providerFolderId: "folder-9" },
  );
  const withoutState = { ...report };
  delete withoutState.state;
  for (const bad of [
    { ...report, state: "fine" },
    { ...report, state: "OK" },
    { ...report, itemCount: -1 },
    { ...report, itemCount: 1.5 },
    { ...report, itemCount: 100_000_001 },
    { ...report, observedAt: -1 },
    { ...report, providerFolderId: "" },
    { ...report, watcherId: "x" },
    withoutState,
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});
