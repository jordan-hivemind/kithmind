import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { VerifiedDropboxOriginal } from "./dropboxOriginal.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const ACCOUNT_ID = /^dbid:[A-Za-z0-9_-]{1,256}$/;
const ITEM_ID = /^id:[A-Za-z0-9_-]{1,256}$/;
const REVISION = /^[\x21-\x7e]{1,128}$/;
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
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(path) ||
    (await realpath(path).catch(() => "")) !== path
  )
    fail("registry path is invalid");
  const info = await lstat(path).catch(() => fail("registry is unavailable"));
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    fail("registry is not protected");
  let ancestor = path;
  while (true) {
    const current = await lstat(ancestor).catch(() =>
      fail("registry ancestor is unavailable"),
    );
    const stickyRoot = current.uid === 0 && (current.mode & 0o1000) !== 0;
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (current.uid !== process.getuid?.() && current.uid !== 0) ||
      ((current.mode & 0o022) !== 0 && !stickyRoot)
    )
      fail("registry ancestor is not protected");
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return info;
}

function canonicalManifest(value: VerifiedDropboxOriginal): Buffer {
  if (
    value.metadata.referenceVersion !== "provider_original_v1" ||
    value.metadata.providerKind !== "dropbox_v1" ||
    value.metadata.providerRevision !== value.binding.providerRevision
  )
    fail("manifest is invalid");
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
  validateManifest(manifest, value.binding.bindingId);
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_MANIFEST_BYTES) {
    bytes.fill(0);
    fail("manifest exceeds bound");
  }
  return bytes;
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function validRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/[\\\x00-\x1f\x7f]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          part.trim() === part,
      )
  );
}

function validateManifest(
  value: Record<string, unknown>,
  bindingId: string,
): VerifiedDropboxOriginal {
  const expectedKeys = [
    "bindingId",
    "providerAccountId",
    "providerAccountIdHash",
    "providerContentHash",
    "providerFileId",
    "providerFileIdHash",
    "providerKind",
    "providerRevision",
    "providerRootDirectoryId",
    "providerRootDirectoryIdHash",
    "relativePath",
    "sourceByteLength",
    "sourceContentHash",
    "verifiedAt",
    "version",
  ]
    .sort()
    .join(",");
  if (
    Object.keys(value).sort().join(",") !== expectedKeys ||
    value.version !== "provider_locator_manifest_v1" ||
    value.providerKind !== "dropbox_v1" ||
    value.bindingId !== bindingId ||
    typeof value.providerAccountId !== "string" ||
    !ACCOUNT_ID.test(value.providerAccountId) ||
    typeof value.providerRootDirectoryId !== "string" ||
    !ITEM_ID.test(value.providerRootDirectoryId) ||
    typeof value.providerFileId !== "string" ||
    !ITEM_ID.test(value.providerFileId) ||
    typeof value.providerRevision !== "string" ||
    !REVISION.test(value.providerRevision) ||
    !validRelativePath(value.relativePath) ||
    typeof value.providerAccountIdHash !== "string" ||
    !HEX.test(value.providerAccountIdHash) ||
    digest(value.providerAccountId) !== value.providerAccountIdHash ||
    typeof value.providerRootDirectoryIdHash !== "string" ||
    !HEX.test(value.providerRootDirectoryIdHash) ||
    digest(value.providerRootDirectoryId) !==
      value.providerRootDirectoryIdHash ||
    typeof value.providerFileIdHash !== "string" ||
    !HEX.test(value.providerFileIdHash) ||
    digest(value.providerFileId) !== value.providerFileIdHash ||
    typeof value.providerContentHash !== "string" ||
    !HEX.test(value.providerContentHash) ||
    typeof value.sourceContentHash !== "string" ||
    !HEX.test(value.sourceContentHash) ||
    !Number.isSafeInteger(value.sourceByteLength) ||
    (value.sourceByteLength as number) < 1 ||
    (value.sourceByteLength as number) > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(value.verifiedAt) ||
    (value.verifiedAt as number) < 0 ||
    (value.verifiedAt as number) > Date.now() + 5 * 60_000
  )
    fail("manifest is invalid");
  return {
    metadata: {
      referenceVersion: "provider_original_v1",
      providerKind: "dropbox_v1",
      providerAccountIdHash: value.providerAccountIdHash,
      providerRootDirectoryIdHash: value.providerRootDirectoryIdHash,
      providerFileIdHash: value.providerFileIdHash,
      providerRevision: value.providerRevision,
      providerContentHash: value.providerContentHash,
      sourceContentHash: value.sourceContentHash,
      sourceByteLength: value.sourceByteLength as number,
      verifiedAt: value.verifiedAt as number,
    },
    binding: {
      bindingId,
      providerAccountId: value.providerAccountId,
      providerRootDirectoryId: value.providerRootDirectoryId,
      providerFileId: value.providerFileId,
      providerRevision: value.providerRevision,
      relativePath: value.relativePath,
    },
  };
}

async function readExact(path: string): Promise<Buffer | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("registry entry cannot be inspected");
  });
  if (!info) return undefined;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size < 1 ||
    info.size > MAX_MANIFEST_BYTES ||
    !constants.O_NOFOLLOW ||
    !constants.O_NONBLOCK
  )
    fail("registry entry is not protected");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600
    )
      fail("registry entry changed during open");
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      before.dev !== info.dev ||
      before.ino !== info.ino ||
      offset !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      bytes.fill(0);
      fail("registry entry changed during read");
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export type PersistedProviderBinding = {
  bindingId: string;
  manifestPath: string;
  manifestFingerprint: string;
  manifestByteLength: number;
};

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function loadProviderBinding(input: {
  registryDirectory: string;
  bindingId: string;
}): Promise<
  | { persisted: PersistedProviderBinding; verified: VerifiedDropboxOriginal }
  | undefined
> {
  if (!UUID.test(input.bindingId)) fail("binding identity is invalid");
  await directory(input.registryDirectory);
  const path = join(input.registryDirectory, `${input.bindingId}.json`);
  const bytes = await readExact(path);
  if (!bytes) return undefined;
  try {
    let row: unknown;
    try {
      row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("manifest is invalid");
    }
    if (!row || typeof row !== "object" || Array.isArray(row))
      fail("manifest is invalid");
    const value = row as Record<string, unknown>;
    const verified = validateManifest(value, input.bindingId);
    const canonical = canonicalManifest(verified);
    try {
      if (!canonical.equals(bytes)) fail("manifest is not canonical");
    } finally {
      canonical.fill(0);
    }
    return {
      persisted: {
        bindingId: input.bindingId,
        manifestPath: path,
        manifestFingerprint: createHash("sha256").update(bytes).digest("hex"),
        manifestByteLength: bytes.length,
      },
      verified,
    };
  } finally {
    bytes.fill(0);
  }
}

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
  let existing: Buffer | undefined;
  try {
    existing = await readExact(finalPath);
    if (!existing) {
      let temporary = await readExact(temporaryPath);
      if (temporary) {
        try {
          if (!temporary.equals(expected)) fail("temporary binding conflicts");
        } finally {
          temporary.fill(0);
        }
      } else {
        const handle = await open(
          temporaryPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        ).catch(() => fail("temporary binding cannot be created"));
        try {
          await handle.writeFile(expected);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await link(temporaryPath, finalPath).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          fail("binding cannot be published");
      });
      existing = await readExact(finalPath);
      if (!existing) fail("published binding is missing");
      if (!existing.equals(expected))
        fail("binding conflicts with existing entry");
      await unlink(temporaryPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          fail("temporary binding cannot be removed");
      });
      await syncDirectory(input.registryDirectory);
    } else {
      if (!existing.equals(expected))
        fail("binding conflicts with existing entry");
      const temporary = await readExact(temporaryPath);
      if (temporary) {
        try {
          if (!temporary.equals(expected)) fail("temporary binding conflicts");
        } finally {
          temporary.fill(0);
        }
        await unlink(temporaryPath).catch(() =>
          fail("temporary binding cannot be removed"),
        );
        await syncDirectory(input.registryDirectory);
      }
    }
    const after = await directory(input.registryDirectory);
    if (after.dev !== root.dev || after.ino !== root.ino)
      fail("registry changed during write");
    return {
      bindingId,
      manifestPath: finalPath,
      manifestFingerprint: createHash("sha256").update(expected).digest("hex"),
      manifestByteLength: expected.length,
    };
  } finally {
    existing?.fill(0);
    expected.fill(0);
  }
}

export async function removeProviderBindingExact(input: {
  registryDirectory: string;
  bindingId: string;
  manifestFingerprint: string;
  manifestByteLength: number;
}): Promise<{ outcome: "deleted" | "already_missing" }> {
  if (
    !UUID.test(input.bindingId) ||
    !HEX.test(input.manifestFingerprint) ||
    !Number.isSafeInteger(input.manifestByteLength) ||
    input.manifestByteLength < 1 ||
    input.manifestByteLength > MAX_MANIFEST_BYTES
  )
    fail("binding identity is invalid");
  const root = await directory(input.registryDirectory);
  const finalPath = join(input.registryDirectory, `${input.bindingId}.json`);
  const temporaryPath = join(input.registryDirectory, `${input.bindingId}.tmp`);
  const final = await readExact(finalPath);
  const temporary = await readExact(temporaryPath);
  try {
    for (const bytes of [final, temporary]) {
      if (
        bytes &&
        (bytes.length !== input.manifestByteLength ||
          createHash("sha256").update(bytes).digest("hex") !==
            input.manifestFingerprint)
      )
        fail("binding removal conflicts");
    }
    if (!final && !temporary) return { outcome: "already_missing" };
    if (final)
      await unlink(finalPath).catch(() => fail("binding cannot be removed"));
    if (temporary)
      await unlink(temporaryPath).catch(() =>
        fail("temporary binding cannot be removed"),
      );
    await syncDirectory(input.registryDirectory);
    const after = await directory(input.registryDirectory);
    const finalAfter = await readExact(finalPath);
    const temporaryAfter = await readExact(temporaryPath);
    try {
      if (
        after.dev !== root.dev ||
        after.ino !== root.ino ||
        finalAfter ||
        temporaryAfter
      )
        fail("registry changed during removal");
    } finally {
      finalAfter?.fill(0);
      temporaryAfter?.fill(0);
    }
    return { outcome: "deleted" };
  } finally {
    final?.fill(0);
    temporary?.fill(0);
  }
}
