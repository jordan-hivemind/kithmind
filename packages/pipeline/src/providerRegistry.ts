import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { VerifiedDropboxOriginal } from "./dropboxOriginal.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MANIFEST_BYTES = 32 * 1024;

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(`Provider registry failed: ${message}`);
    this.name = "ProviderRegistryError";
  }
}

function fail(message: string): never {
  throw new ProviderRegistryError(message);
}

async function directory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || await realpath(path).catch(() => "") !== path) fail("registry path is invalid");
  const info = await lstat(path).catch(() => fail("registry is unavailable"));
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) fail("registry is not protected");
  return info;
}

function canonicalManifest(value: VerifiedDropboxOriginal): Buffer {
  const manifest = {
    version: "provider_locator_manifest_v1",
    bindingId: value.binding.bindingId,
    providerKind: value.metadata.providerKind,
    providerAccountId: value.binding.providerAccountId,
    providerRootDirectoryId: value.binding.providerRootDirectoryId,
    providerFileId: value.binding.providerFileId,
    providerRevision: value.binding.providerRevision,
    relativePath: value.binding.relativePath,
    providerAccountIdHash: value.metadata.providerAccountIdHash,
    providerRootDirectoryIdHash: value.metadata.providerRootDirectoryIdHash,
    providerFileIdHash: value.metadata.providerFileIdHash,
    providerContentHash: value.metadata.providerContentHash,
    sourceContentHash: value.metadata.sourceContentHash,
    sourceByteLength: value.metadata.sourceByteLength,
    verifiedAt: value.metadata.verifiedAt,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_MANIFEST_BYTES) {
    bytes.fill(0);
    fail("manifest exceeds bound");
  }
  return bytes;
}

async function readExact(path: string): Promise<Buffer | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("registry entry cannot be inspected");
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > MAX_MANIFEST_BYTES || !constants.O_NOFOLLOW) fail("registry entry is not protected");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== info.dev || before.ino !== info.ino || bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      bytes.fill(0);
      fail("registry entry changed during read");
    }
    return bytes;
  } finally { await handle.close(); }
}

export type PersistedProviderBinding = {
  bindingId: string;
  manifestPath: string;
  manifestFingerprint: string;
  manifestByteLength: number;
};

export async function persistProviderBinding(input: {
  registryDirectory: string;
  verified: VerifiedDropboxOriginal;
}): Promise<PersistedProviderBinding> {
  const bindingId = input.verified.binding.bindingId;
  if (!UUID.test(bindingId)) fail("binding identity is invalid");
  const root = await directory(input.registryDirectory);
  const finalPath = join(input.registryDirectory, `${bindingId}.json`);
  const temporaryPath = join(input.registryDirectory, `${bindingId}.tmp`);
  const expected = canonicalManifest(input.verified);
  try {
    let existing = await readExact(finalPath);
    if (!existing) {
      let temporary = await readExact(temporaryPath);
      if (temporary) {
        try {
          if (!temporary.equals(expected)) fail("temporary binding conflicts");
        } finally { temporary.fill(0); }
      } else {
        const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(() => fail("temporary binding cannot be created"));
        try { await handle.writeFile(expected); await handle.sync(); }
        finally { await handle.close(); }
      }
      await link(temporaryPath, finalPath).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("binding cannot be published");
      });
      existing = await readExact(finalPath);
      if (!existing) fail("published binding is missing");
      await unlink(temporaryPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("temporary binding cannot be removed");
      });
      const directoryHandle = await open(input.registryDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
    try {
      if (!existing.equals(expected)) fail("binding conflicts with existing entry");
    } finally { existing.fill(0); }
    const after = await directory(input.registryDirectory);
    if (after.dev !== root.dev || after.ino !== root.ino) fail("registry changed during write");
    return {
      bindingId,
      manifestPath: finalPath,
      manifestFingerprint: createHash("sha256").update(expected).digest("hex"),
      manifestByteLength: expected.length,
    };
  } finally { expected.fill(0); }
}
