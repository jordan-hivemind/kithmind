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
          // ADM-10 review: always sent, and minted once per process.
          "heartbeatNonce",
          "operation",
          "protocolVersion",
          "sourceAccountId",
          "spaceId",
          "watcherId",
        ]);
        assert.match(request.heartbeatNonce, /^[0-9a-f]{32}$/);
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

// ADM-10 review, version skew. A server older than ADM-10 refuses an unknown
// key outright rather than ignoring it, and that would kill the heartbeat --
// which is the bug this task exists to fix. The first `invalid_request` drops
// both ADM-10 fields for the rest of the process and retries at once, so the
// worker is safe to deploy before or after its server.
test("a server too old for the ADM-10 fields gets a heartbeat anyway", async () => {
  const sent = [];
  let accepted = 0;
  const heartbeat = new WatchHeartbeat(
    config,
    {
      call: async (request) => {
        sent.push(Object.keys(request).sort());
        if (
          "heartbeatNonce" in request ||
          "legacyWatcherId" in request
        )
          return { error: { code: "invalid_request" } };
        accepted += 1;
        return {
          operation: "diagnostics.heartbeat",
          sourceAccountId: "source",
          watcherId: request.watcherId,
          receivedAt: 1,
          nextExpectedAt: 180_001,
        };
      },
    },
    watcherId,
    "22222222-2222-4222-8222-222222222222",
  );
  try {
    await heartbeat.ping();
    // One rejected attempt, then the same tick retries without the fields.
    assert.equal(sent.length, 2);
    assert.ok(sent[0].includes("heartbeatNonce"));
    assert.ok(sent[0].includes("legacyWatcherId"));
    assert.ok(!sent[1].includes("heartbeatNonce"));
    assert.ok(!sent[1].includes("legacyWatcherId"));
    assert.equal(accepted, 1);

    // And it stays dropped: no extra round trip on every later tick.
    await heartbeat.ping();
    assert.equal(sent.length, 3);
    assert.ok(!sent[2].includes("heartbeatNonce"));
    assert.equal(accepted, 2);
  } finally {
    heartbeat.stop();
  }
});

test("one WatchHeartbeat is one nonce, for every ping it sends", async () => {
  const nonces = new Set();
  const heartbeat = new WatchHeartbeat(
    config,
    {
      call: async (request) => {
        nonces.add(request.heartbeatNonce);
        return {
          operation: "diagnostics.heartbeat",
          sourceAccountId: "source",
          watcherId: request.watcherId,
          receivedAt: 1,
          nextExpectedAt: 180_001,
        };
      },
    },
    watcherId,
  );
  try {
    await heartbeat.ping();
    await heartbeat.ping();
    await heartbeat.ping();
    assert.equal(nonces.size, 1, "a process must not look like two hosts");
    // A second process is a second nonce, which is what makes two live hosts
    // visible at all.
    const other = new WatchHeartbeat(config, { call: async () => ({}) }, watcherId);
    assert.notEqual(other.heartbeatNonce, [...nonces][0]);
    assert.match(other.heartbeatNonce, /^[0-9a-f]{32}$/);
  } finally {
    heartbeat.stop();
  }
});

// ADM-9 follow-up. `ping` swallowed every failure with a bare `catch {}`, and
// that hid a real incident on the owner's host: a watcher whose `watcherId` no
// longer matches the registered one is answered `identity_review_required` on
// every tick forever, passes keep completing because no other operation in the
// protocol carries a `watcherId`, and the only symptom is `last_seen_at`
// frozen at the moment the journal was recreated. The refusal now names itself
// -- once per process, because at 30 seconds a repeating line is a log nobody
// reads and this condition never clears on its own.
//
// One test for both failure shapes, because the "once" is a module-level fact
// about the process and splitting it in two would make the second test depend
// on the first having run. `ping` is reached directly: `private` is a
// TypeScript-only marker and this suite drives the compiled class.
test("a refused heartbeat says so once and keeps beating", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const line = args.join(" ");
    if (line.includes("watcher heartbeat is not being accepted"))
      warnings.push(line);
  };
  let calls = 0;
  let mode = "refused";
  const heartbeat = new WatchHeartbeat(
    config,
    {
      call: async () => {
        calls += 1;
        if (mode === "thrown")
          throw new Error("worker request could not be completed");
        return { error: { code: "identity_review_required" } };
      },
    },
    watcherId,
  );
  try {
    await heartbeat.ping();
    assert.equal(calls, 1);
    assert.equal(warnings.length, 1, "the refusal is reported");
    assert.match(warnings[0], /identity_review_required/);
    assert.match(warnings[0], /re-registered/);

    // Every refusal after it is silent, and the loop has not stopped.
    await heartbeat.ping();
    mode = "thrown";
    await heartbeat.ping();
    assert.equal(calls, 3, "the heartbeat keeps trying");
    assert.equal(warnings.length, 1, "and does not repeat itself");
  } finally {
    heartbeat.stop();
    console.warn = originalWarn;
  }
});
