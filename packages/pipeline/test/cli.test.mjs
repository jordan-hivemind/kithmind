import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { argumentsFor, runWatch } from "../dist/cli.js";

const watchConfig = {
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

const watcherId = "11111111-1111-4111-8111-111111111111";

test("the root pnpm alias forwarding separator is consumed exactly once", () => {
  assert.deepEqual(
    argumentsFor(["--", "run", "--config", "/tmp/config.json"]),
    {
      command: "run",
      configPath: "/tmp/config.json",
    },
  );
  assert.deepEqual(argumentsFor(["watch", "--config", "/tmp/config.json"]), {
    command: "watch",
    configPath: "/tmp/config.json",
  });
  assert.throws(() =>
    argumentsFor(["--", "--", "run", "--config", "/tmp/config.json"]),
  );
});

test("archive forget requires an exact source identity and epoch", () => {
  const parsed = argumentsFor([
    "forget-archive",
    "--source-item",
    "source_item",
    "--config",
    "/tmp/config.json",
    "--forget-epoch",
    "7",
    "--source-external-id",
    "11111111-1111-4111-8111-111111111111",
    "--json",
  ]);
  assert.deepEqual(parsed, {
    command: "forget-archive",
    configPath: "/tmp/config.json",
    sourceItemId: "source_item",
    sourceExternalId: "11111111-1111-4111-8111-111111111111",
    forgetEpoch: 7,
    json: true,
  });
  for (const args of [
    [
      "forget-archive",
      "--config",
      "/tmp/config.json",
      "--source-item",
      "source_item",
      "--forget-epoch",
      "7",
    ],
    [
      "forget-archive",
      "--config",
      "/tmp/config.json",
      "--source-item",
      "source_item",
      "--source-external-id",
      "11111111-1111-4111-8111-111111111111",
      "--forget-epoch",
      "0",
    ],
    [
      "forget-archive",
      "--config",
      "/tmp/config.json",
      "--config",
      "/tmp/other.json",
      "--source-item",
      "source_item",
      "--source-external-id",
      "11111111-1111-4111-8111-111111111111",
      "--forget-epoch",
      "7",
    ],
  ])
    assert.throws(() => argumentsFor(args));
});

test("invocation through a symlink still runs the CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-cli-test-"));
  const link = join(directory, "pipeline-worker");
  const target = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  await symlink(target, link);
  try {
    const result = spawnSync(process.execPath, [link, "invalid"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Pipeline worker failed\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a contended or unsafe journal sends no heartbeat", async () => {
  for (const reason of ["contended", "unsafe"]) {
    let transportCalls = 0;
    await assert.rejects(
      () =>
        runWatch("ignored", {
          loadConfig: async () => watchConfig,
          credential: () => "synthetic-credential",
          openJournal: async () => {
            throw new Error(reason);
          },
          transport: () => ({
            call: async () => {
              transportCalls += 1;
              throw new Error("must not heartbeat");
            },
          }),
        }),
      new RegExp(reason),
    );
    assert.equal(transportCalls, 0);
  }
});

test("a changed quiescent credential cannot heartbeat before journal reauthorization", async () => {
  let closed = false;
  let transportCalls = 0;
  await assert.rejects(
    runWatch("ignored", {
      loadConfig: async () => watchConfig,
      credential: () => "replacement-synthetic-credential",
      openJournal: async () => ({
        watcherId,
        credentialStatus: "changed_quiescent",
        close: async () => {
          closed = true;
        },
      }),
      transport: () => ({
        call: async () => {
          transportCalls += 1;
        },
      }),
    }),
    /credential recovery is required/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
  assert.equal(transportCalls, 0);
});

test("stopping watch during a pass stops future heartbeats and closes its journal", async () => {
  const stop = new AbortController();
  let heartbeatCalls = 0;
  let closed = false;
  let started;
  let heartbeatStarted;
  const passStarted = new Promise((resolve) => {
    started = resolve;
  });
  const firstHeartbeat = new Promise((resolve) => {
    heartbeatStarted = resolve;
  });
  const watch = runWatch("ignored", {
    signal: stop.signal,
    loadConfig: async () => watchConfig,
    credential: () => "synthetic-credential",
    openJournal: async () => ({
      watcherId,
      credentialStatus: "current",
      close: async () => {
        closed = true;
      },
    }),
    transport: () => ({
      call: async (request) => {
        heartbeatCalls += 1;
        heartbeatStarted();
        return {
          operation: "diagnostics.heartbeat",
          sourceAccountId: "source",
          watcherId: request.watcherId,
          receivedAt: 1,
          nextExpectedAt: 180_001,
        };
      },
    }),
    executePass: async () => {
      started();
      await new Promise((resolve) =>
        stop.signal.addEventListener("abort", resolve, { once: true }),
      );
      return { state: "complete" };
    },
    write: () => undefined,
  });
  await passStarted;
  await firstHeartbeat;
  assert.equal(heartbeatCalls, 1);
  stop.abort();
  await watch;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heartbeatCalls, 1);
  assert.equal(closed, true);
});
