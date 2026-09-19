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

// ADM-9. The terminal outcome of one pass. Closed state, bounded counts, and a
// code that is a lower-case ASCII literal rather than free text -- the health
// screen renders it in a tooltip, so a path or a file name must be
// unrepresentable, not merely discouraged.
const outcome = {
  ...source,
  operation: "diagnostics.passOutcome",
  watcherId: "0f1e2d3c-4b5a-4968-8776-655443322110",
  state: "incomplete",
  scanned: 0,
  published: 0,
  finishedAt: 1_758_196_800_000,
};

test("diagnostics.passOutcome takes a closed state and a bounded code", () => {
  assert.deepEqual(parseWorkerRequest(outcome), outcome);
  const refused = { ...outcome, code: "root_contents_collapsed" };
  assert.deepEqual(parseWorkerRequest(refused), refused);
  const withoutState = { ...outcome };
  delete withoutState.state;
  const withoutScanned = { ...outcome };
  delete withoutScanned.scanned;
  for (const bad of [
    { ...outcome, state: "refused" },
    { ...outcome, state: "Complete" },
    // Never free text, never a path, never a file name.
    { ...outcome, code: "root contents collapsed" },
    { ...outcome, code: "/Users/someone/Finance/statement.pdf" },
    { ...outcome, code: "Statement.PDF" },
    { ...outcome, code: "a".repeat(65) },
    { ...outcome, code: "" },
    { ...outcome, scanned: -1 },
    { ...outcome, scanned: 1.5 },
    { ...outcome, published: 100_000_001 },
    { ...outcome, finishedAt: -1 },
    { ...outcome, watcherId: "not-a-uuid" },
    withoutState,
    withoutScanned,
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});

// Version skew, the half this package can assert. A new worker sends a field
// an old server has never heard of; that server's parser -- this one, with the
// operation's key list as it was -- refuses the whole request rather than
// ignoring the field, which is why the watcher's send is best-effort and its
// refusal never fails the pass.
test("an unknown field is refused rather than ignored, on every operation", () => {
  for (const request of [
    { ...source, operation: "source.status" },
    { ...source, operation: "diagnostics.heartbeat", watcherId: outcome.watcherId, connectorVersion: "1.2.3" },
    outcome,
  ]) {
    assert.deepEqual(parseWorkerRequest(request), request);
    assert.throws(
      () => parseWorkerRequest({ ...request, unexpectedFuture: 1 }),
      WorkerProtocolParseError,
    );
  }
  // And the other direction: an old worker that never sends the new operation
  // is parsed by the new server exactly as it was before.
  assert.deepEqual(
    parseWorkerRequest({ ...source, operation: "source.roots" }),
    { ...source, operation: "source.roots" },
  );
});

// ADM-10. `legacyWatcherId` on the heartbeat, and the skew it creates.
test("diagnostics.heartbeat takes an optional legacy watcher id", () => {
  const heartbeat = {
    ...source,
    operation: "diagnostics.heartbeat",
    watcherId: outcome.watcherId,
    connectorVersion: "1.2.3",
  };
  // Old worker to new server: the field is absent and nothing changes.
  assert.deepEqual(parseWorkerRequest(heartbeat), heartbeat);

  const withLegacy = {
    ...heartbeat,
    legacyWatcherId: "10000000-0000-4000-8000-000000000002",
  };
  assert.deepEqual(parseWorkerRequest(withLegacy), withLegacy);

  // Same shape rule as `watcherId`: a canonical UUID and nothing else, so it
  // can never smuggle a path or a host name into the column the health screen
  // renders.
  for (const bad of [
    { ...heartbeat, legacyWatcherId: "not-a-uuid" },
    { ...heartbeat, legacyWatcherId: "" },
    { ...heartbeat, legacyWatcherId: "/Users/someone/journal" },
    { ...heartbeat, legacyWatcherId: null },
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});

// ADM-10 review, finding 1. The per-process nonce that tells two live hosts
// sharing one copied journal apart.
test("diagnostics.heartbeat takes an optional per-process nonce", () => {
  const heartbeat = {
    ...source,
    operation: "diagnostics.heartbeat",
    watcherId: outcome.watcherId,
    connectorVersion: "1.2.3",
  };
  const withNonce = { ...heartbeat, heartbeatNonce: "a".repeat(32) };
  assert.deepEqual(parseWorkerRequest(withNonce), withNonce);

  // Both optional fields together, which is what a current worker sends.
  const both = {
    ...withNonce,
    legacyWatcherId: "10000000-0000-4000-8000-000000000002",
  };
  assert.deepEqual(parseWorkerRequest(both), both);

  // A closed shape, not a bounded string: the server stores it and it is one
  // join from the health screen, so a host name or a path must not fit.
  for (const bad of [
    { ...heartbeat, heartbeatNonce: "A".repeat(32) },
    { ...heartbeat, heartbeatNonce: "a".repeat(31) },
    { ...heartbeat, heartbeatNonce: "a".repeat(33) },
    { ...heartbeat, heartbeatNonce: "" },
    { ...heartbeat, heartbeatNonce: "worker-host.local".padEnd(32, "0") },
    { ...heartbeat, heartbeatNonce: null },
  ]) {
    assert.throws(() => parseWorkerRequest(bad), WorkerProtocolParseError);
  }
});
