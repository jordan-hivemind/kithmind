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
