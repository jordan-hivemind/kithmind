import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { argumentsFor } from "../dist/cli.js";

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
