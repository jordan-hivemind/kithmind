import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  chmod,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadProviderBinding,
  persistProviderBinding,
  ProviderRegistryError,
  removeProviderBindingExact,
} from "../dist/providerRegistry.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");

const verified = {
  metadata: {
    referenceVersion: "provider_original_v1",
    providerKind: "dropbox_v1",
    providerAccountIdHash: hash("dbid:account"),
    providerRootDirectoryIdHash: hash("id:root"),
    providerFileIdHash: hash("id:file"),
    providerRevision: "rev1",
    providerContentHash: "d".repeat(64),
    sourceContentHash: "e".repeat(64),
    sourceByteLength: 123,
    verifiedAt: 1,
  },
  binding: {
    bindingId: "123e4567-e89b-42d3-a456-426614174000",
    providerAccountId: "dbid:account",
    providerRootDirectoryId: "id:root",
    providerFileId: "id:file",
    providerRevision: "rev1",
    relativePath: "Folder/file.pdf",
  },
};

test("provider registry publishes one immutable protected manifest and replays exactly", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "provider-registry-")),
  );
  await chmod(root, 0o700);
  try {
    const first = await persistProviderBinding({
      registryDirectory: root,
      verified,
    });
    const second = await persistProviderBinding({
      registryDirectory: root,
      verified,
    });
    assert.deepEqual(second, first);
    assert.deepEqual(
      (
        await loadProviderBinding({
          registryDirectory: root,
          bindingId: verified.binding.bindingId,
        })
      ).verified,
      verified,
    );
    assert.equal(
      (await readFile(first.manifestPath, "utf8")).includes("id:file"),
      true,
    );
    await assert.rejects(
      () =>
        persistProviderBinding({
          registryDirectory: root,
          verified: {
            metadata: {
              ...verified.metadata,
              providerFileIdHash: hash("id:changed"),
            },
            binding: { ...verified.binding, providerFileId: "id:changed" },
          },
        }),
      (error) =>
        error instanceof ProviderRegistryError &&
        /conflicts/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider registry recovers an exact durable temporary manifest and rejects replacement", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "provider-registry-")),
  );
  await chmod(root, 0o700);
  try {
    const expectedRoot = await realpath(
      await mkdtemp(join(tmpdir(), "provider-registry-source-")),
    );
    await chmod(expectedRoot, 0o700);
    const seeded = await persistProviderBinding({
      registryDirectory: expectedRoot,
      verified,
    });
    const bytes = await readFile(seeded.manifestPath);
    await writeFile(join(root, `${verified.binding.bindingId}.tmp`), bytes, {
      mode: 0o600,
    });
    const result = await persistProviderBinding({
      registryDirectory: root,
      verified,
    });
    assert.equal(result.bindingId, verified.binding.bindingId);
    await writeFile(join(root, `${verified.binding.bindingId}.tmp`), bytes, {
      mode: 0o600,
    });
    await persistProviderBinding({ registryDirectory: root, verified });
    await assert.rejects(
      () => stat(join(root, `${verified.binding.bindingId}.tmp`)),
      { code: "ENOENT" },
    );
    await rm(expectedRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider registry preserves recovery evidence when a published entry conflicts", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "provider-registry-")),
  );
  await chmod(root, 0o700);
  try {
    const first = await persistProviderBinding({
      registryDirectory: root,
      verified,
    });
    const temporaryPath = join(root, `${verified.binding.bindingId}.tmp`);
    const exact = await readFile(first.manifestPath);
    await writeFile(temporaryPath, exact, { mode: 0o600 });
    await writeFile(
      first.manifestPath,
      Buffer.from(`${"x".repeat(exact.length - 1)}\n`),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => persistProviderBinding({ registryDirectory: root, verified }),
      ProviderRegistryError,
    );
    assert.deepEqual(await readFile(temporaryPath), exact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider registry rejects malformed, oversized, and unsafe persisted data", async () => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "provider-registry-parent-")),
  );
  const root = join(parent, "registry");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(root, { mode: 0o700 }),
  );
  const path = join(root, `${verified.binding.bindingId}.json`);
  try {
    await writeFile(path, "{raw-secret", { mode: 0o600 });
    await assert.rejects(
      () =>
        loadProviderBinding({
          registryDirectory: root,
          bindingId: verified.binding.bindingId,
        }),
      (error) =>
        error instanceof ProviderRegistryError &&
        error.message === "Provider registry failed: manifest is invalid" &&
        !error.message.includes("raw-secret"),
    );
    await writeFile(path, Buffer.alloc(32 * 1024 + 1, 0x61), { mode: 0o600 });
    await assert.rejects(
      () =>
        loadProviderBinding({
          registryDirectory: root,
          bindingId: verified.binding.bindingId,
        }),
      ProviderRegistryError,
    );
    await rm(path);
    await chmod(parent, 0o777);
    await assert.rejects(
      () => persistProviderBinding({ registryDirectory: root, verified }),
      /ancestor is not protected/,
    );
  } finally {
    await chmod(parent, 0o700);
    await rm(parent, { recursive: true, force: true });
  }
});

test("provider registry removes exact final and crash-temporary bindings idempotently", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "provider-registry-")),
  );
  await chmod(root, 0o700);
  try {
    const persisted = await persistProviderBinding({
      registryDirectory: root,
      verified,
    });
    const exact = await readFile(persisted.manifestPath);
    const temporaryPath = join(root, `${verified.binding.bindingId}.tmp`);
    await writeFile(temporaryPath, exact, { mode: 0o600 });
    assert.deepEqual(
      await removeProviderBindingExact({
        registryDirectory: root,
        bindingId: persisted.bindingId,
        manifestFingerprint: persisted.manifestFingerprint,
        manifestByteLength: persisted.manifestByteLength,
      }),
      { outcome: "deleted" },
    );
    assert.deepEqual(
      await removeProviderBindingExact({
        registryDirectory: root,
        bindingId: persisted.bindingId,
        manifestFingerprint: persisted.manifestFingerprint,
        manifestByteLength: persisted.manifestByteLength,
      }),
      { outcome: "already_missing" },
    );
    await writeFile(temporaryPath, Buffer.from("conflict\n"), { mode: 0o600 });
    await assert.rejects(
      () =>
        removeProviderBindingExact({
          registryDirectory: root,
          bindingId: persisted.bindingId,
          manifestFingerprint: persisted.manifestFingerprint,
          manifestByteLength: persisted.manifestByteLength,
        }),
      /removal conflicts/,
    );
    assert.equal(await readFile(temporaryPath, "utf8"), "conflict\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
