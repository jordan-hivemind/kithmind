import assert from "node:assert/strict";
import test from "node:test";

import {
  WatchHeartbeat,
  parseDiagnosticsStatus,
  parseHeartbeatResponse,
} from "../dist/diagnostics.js";

const watcherId = "11111111-1111-4111-8111-111111111111";
const config = {
  protocolVersion: 1,
  endpoint: "http://127.0.0.1:3100/api/worker",
  spaceId: "space",
  sourceAccountId: "source",
  credentialEnv: "PIPELINE_TOKEN",
  roots: [{ alias: "fixture", path: "/tmp/fixture" }],
  journalDir: "/tmp/journal",
  watchIntervalMs: 1_000,
  maxFiles: 1,
  maxDepth: 1,
  maxFileBytes: 1,
};

function status(overrides = {}) {
  return {
    operation: "diagnostics.status",
    diagnosticsVersion: 1,
    sourceAccountId: "source",
    source: "enabled",
    watcher: {
      state: "current",
      watcherId,
      lastSeenAt: 1,
      nextExpectedAt: 180_001,
    },
    incident: { state: "none" },
    ...overrides,
  };
}

test("diagnostics status validates every watcher and incident state", () => {
  assert.equal(parseDiagnosticsStatus(status()).watcher.state, "current");
  assert.equal(
    parseDiagnosticsStatus(status({ watcher: { state: "not_configured" } }))
      .watcher.state,
    "not_configured",
  );
  assert.equal(
    parseDiagnosticsStatus(
      status({ watcher: { state: "awaiting_heartbeat", watcherId } }),
    ).watcher.state,
    "awaiting_heartbeat",
  );
  assert.equal(
    parseDiagnosticsStatus(
      status({
        watcher: {
          state: "overdue",
          watcherId,
          lastSeenAt: 1,
          nextExpectedAt: 180_001,
        },
        incident: { state: "open", kind: "missing_worker", openedAt: 180_002 },
      }),
    ).incident.state,
    "open",
  );
  for (const invalid of [
    status({
      watcher: {
        state: "current",
        watcherId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(),
        lastSeenAt: 1,
        nextExpectedAt: 2,
      },
    }),
    status({
      watcher: {
        state: "current",
        watcherId,
        lastSeenAt: 2,
        nextExpectedAt: 180_001,
      },
    }),
    status({
      watcher: {
        state: "current",
        watcherId,
        lastSeenAt: 1,
        nextExpectedAt: 2,
      },
      incident: { state: "open", kind: "missing_worker", openedAt: 3 },
    }),
    { ...status(), extra: true },
  ]) {
    assert.throws(() => parseDiagnosticsStatus(invalid));
  }
});

test("heartbeat response rejects source, watcher, and deadline mismatches", () => {
  const response = {
    operation: "diagnostics.heartbeat",
    sourceAccountId: "source",
    watcherId,
    receivedAt: 10,
    nextExpectedAt: 180_010,
  };
  assert.doesNotThrow(() =>
    parseHeartbeatResponse(response, "source", watcherId),
  );
  assert.throws(() =>
    parseHeartbeatResponse(
      { ...response, watcherId: "22222222-2222-4222-8222-222222222222" },
      "source",
      watcherId,
    ),
  );
  assert.throws(() =>
    parseHeartbeatResponse(
      { ...response, nextExpectedAt: 11 },
      "source",
      watcherId,
    ),
  );
});

test("watch heartbeat is bounded, non-overlapping, and stops its request", async () => {
  let calls = 0;
  let aborted = false;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const heartbeat = new WatchHeartbeat(
    config,
    {
      call: async (request, signal) => {
        calls += 1;
        assert.deepEqual(Object.keys(request).sort(), [
          "connectorVersion",
          "operation",
          "protocolVersion",
          "sourceAccountId",
          "spaceId",
          "watcherId",
        ]);
        assert.equal(request.operation, "diagnostics.heartbeat");
        signal.addEventListener("abort", () => {
          aborted = true;
          release({
            operation: "diagnostics.heartbeat",
            sourceAccountId: "source",
            watcherId: request.watcherId,
            receivedAt: 1,
            nextExpectedAt: 180_001,
          });
        });
        return pending;
      },
    },
    watcherId,
  );
  heartbeat.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  heartbeat.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(calls, 1);
});
