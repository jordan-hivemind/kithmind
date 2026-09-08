import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectSpoolRoot,
  inspectSpoolIntentState,
  prepareNormalizedBundleSpool,
  publishNormalizedBundleSpool,
  recoverNormalizedBundleSpool,
  removeNormalizedBundleSpoolExact,
  SpoolStoreError,
} from "../dist/spoolStore.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function setup() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "normalized-spool-")),
  );
  const root = join(base, "spool");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(root, { mode: 0o700 }),
  );
  await chmod(root, 0o700);
  const bytes = Buffer.from('{"candidate":"synthetic","schemaVersion":1}\n');
  const source = join(base, "bundle.json");
  await writeFile(source, bytes, { mode: 0o600 });
  const sourceStats = await stat(source);
  const parserOutput = {
    artifacts: {
      normalizedBundle: {
        path: source,
        device: sourceStats.dev,
        inode: sourceStats.ino,
        sha256: sha256(bytes),
        byteLength: bytes.length,
        mediaType: "application/json",
      },
    },
    validated: { bundle: {}, resolvedLocators: {} },
  };
  return {
    base,
    root,
    bytes,
    parserOutput,
    identity: await inspectSpoolRoot(root),
  };
}

test("publishes a prepared spool exactly once and recovers a lost result", async () => {
  const f = await setup();
  try {
    const spoolId = randomUUID();
    const prepared = await prepareNormalizedBundleSpool({
      spoolRoot: f.root,
      expectedRoot: f.identity,
      spoolId,
      parserOutput: f.parserOutput,
    });
    assert.match(prepared.opaqueName, new RegExp(`^\\.${spoolId}\\.`));
    const published = await publishNormalizedBundleSpool({
      spoolRoot: f.root,
      expectedRoot: f.identity,
      spoolId,
      prepared,
    });
    const recovered = await recoverNormalizedBundleSpool({
      spoolRoot: f.root,
      expectedRoot: f.identity,
      spoolId,
      prepared,
    });
    assert.deepEqual(recovered, published);
    assert.deepEqual(await readFile(join(f.root, `${spoolId}.json`)), f.bytes);
    assert.deepEqual(
      await removeNormalizedBundleSpoolExact({
        spoolRoot: f.root,
        expectedRoot: f.identity,
        spool: published,
      }),
      { state: "removed" },
    );
    assert.deepEqual(
      await removeNormalizedBundleSpoolExact({
        spoolRoot: f.root,
        expectedRoot: f.identity,
        spool: published,
      }),
      { state: "already_missing" },
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("detects an unowned spool result without adopting or deleting it", async () => {
  const f = await setup();
  try {
    const spoolId = randomUUID();
    const input = {
      spoolRoot: f.root,
      expectedRoot: f.identity,
      spoolId,
    };
    assert.deepEqual(await inspectSpoolIntentState(input), { state: "absent" });
    const target = join(f.root, `.${spoolId}.${randomUUID()}.tmp`);
    await writeFile(target, f.bytes, { mode: 0o600 });
    assert.deepEqual(await inspectSpoolIntentState(input), {
      state: "present_unowned",
    });
    assert.deepEqual(await readFile(target), f.bytes);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("never clobbers a pre-existing spool destination", async () => {
  const f = await setup();
  try {
    const spoolId = randomUUID();
    const prepared = await prepareNormalizedBundleSpool({
      spoolRoot: f.root,
      expectedRoot: f.identity,
      spoolId,
      parserOutput: f.parserOutput,
    });
    const target = join(f.root, `${spoolId}.json`);
    const sentinel = Buffer.from("pre-existing");
    await writeFile(target, sentinel, { mode: 0o600 });
    await assert.rejects(
      () =>
        publishNormalizedBundleSpool({
          spoolRoot: f.root,
          expectedRoot: f.identity,
          spoolId,
          prepared,
        }),
      (error) =>
        error instanceof SpoolStoreError && error.code === "destination_exists",
    );
    assert.deepEqual(await readFile(target), sentinel);
    assert.deepEqual(
      await readFile(join(f.root, prepared.opaqueName)),
      f.bytes,
    );
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});

test("refuses to delete a replaced spool object", async () => {
  const f = await setup();
  try {
    const spoolId = randomUUID();
    const prepared = await prepareNormalizedBundleSpool({
      spoolRoot: f.root,
      expectedRoot: f.identity,
      spoolId,
      parserOutput: f.parserOutput,
    });
    const published = await publishNormalizedBundleSpool({
      spoolRoot: f.root,
      expectedRoot: f.identity,
      spoolId,
      prepared,
    });
    const target = join(f.root, published.opaqueName);
    const replacement = join(f.root, `${randomUUID()}.json`);
    const sentinel = Buffer.from("replacement");
    await writeFile(replacement, sentinel, { mode: 0o600 });
    await rename(replacement, target);
    await assert.rejects(
      () =>
        removeNormalizedBundleSpoolExact({
          spoolRoot: f.root,
          expectedRoot: f.identity,
          spool: published,
        }),
      (error) =>
        error instanceof SpoolStoreError && error.code === "source_changed",
    );
    assert.deepEqual(await readFile(target), sentinel);
  } finally {
    await rm(f.base, { recursive: true, force: true });
  }
});
