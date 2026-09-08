import assert from "node:assert/strict";
import { mkdtemp, chmod, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { persistProviderBinding, ProviderRegistryError } from "../dist/providerRegistry.js";

const verified = {
  metadata: {
    referenceVersion: "provider_original_v1", providerKind: "dropbox_v1",
    providerAccountIdHash: "a".repeat(64), providerRootDirectoryIdHash: "b".repeat(64),
    providerFileIdHash: "c".repeat(64), providerRevision: "rev1", providerContentHash: "d".repeat(64),
    sourceContentHash: "e".repeat(64), sourceByteLength: 123, verifiedAt: 1,
  },
  binding: {
    bindingId: "123e4567-e89b-42d3-a456-426614174000", providerAccountId: "dbid:account",
    providerRootDirectoryId: "id:root", providerFileId: "id:file", providerRevision: "rev1",
    relativePath: "Folder/file.pdf",
  },
};

test("provider registry publishes one immutable protected manifest and replays exactly", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "provider-registry-")));
  await chmod(root, 0o700);
  try {
    const first = await persistProviderBinding({ registryDirectory: root, verified });
    const second = await persistProviderBinding({ registryDirectory: root, verified });
    assert.deepEqual(second, first);
    assert.equal((await readFile(first.manifestPath, "utf8")).includes("id:file"), true);
    await assert.rejects(
      () => persistProviderBinding({ registryDirectory: root, verified: { ...verified, binding: { ...verified.binding, providerFileId: "id:changed" } } }),
      (error) => error instanceof ProviderRegistryError && /conflicts/.test(error.message),
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("provider registry recovers an exact durable temporary manifest and rejects replacement", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "provider-registry-")));
  await chmod(root, 0o700);
  try {
    const expectedRoot = await realpath(await mkdtemp(join(tmpdir(), "provider-registry-source-")));
    await chmod(expectedRoot, 0o700);
    const seeded = await persistProviderBinding({ registryDirectory: expectedRoot, verified });
    const bytes = await readFile(seeded.manifestPath);
    await writeFile(join(root, `${verified.binding.bindingId}.tmp`), bytes, { mode: 0o600 });
    const result = await persistProviderBinding({ registryDirectory: root, verified });
    assert.equal(result.bindingId, verified.binding.bindingId);
    await rm(expectedRoot, { recursive: true, force: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
