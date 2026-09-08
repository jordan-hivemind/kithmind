import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  DropboxVerificationError,
  withDropboxAccessToken,
  type DropboxCredentialConfig,
} from "./dropboxCredentials.js";

const HEX = /^[a-f0-9]{64}$/;
const ID = /^id:[A-Za-z0-9_-]{1,256}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function fail(message: string): never {
  throw new DropboxVerificationError(message);
}

export type DropboxOriginalInput = {
  credentials: DropboxCredentialConfig;
  refreshPath: string;
  capturePath: string;
  sourceContentHash: string;
  sourceByteLength: number;
  providerAccountIdHash: string;
  providerRootDirectoryIdHash: string;
  providerRootDirectoryId: string;
  relativePath: string;
  bindingId: string;
  expectedProviderFileIdHash?: string;
};

export type VerifiedDropboxOriginal = {
  metadata: {
    referenceVersion: "provider_original_v1";
    providerKind: "dropbox_v1";
    providerAccountIdHash: string;
    providerRootDirectoryIdHash: string;
    providerFileIdHash: string;
    providerRevision: string;
    providerContentHash: string;
    sourceContentHash: string;
    sourceByteLength: number;
    verifiedAt: number;
  };
  /** Private recovery metadata, never included directly in a hosted declaration. */
  binding: {
    bindingId: string;
    providerAccountId: string;
    providerRootDirectoryId: string;
    providerFileId: string;
    providerRevision: string;
    relativePath: string;
  };
};

/** Dropbox hashes SHA-256 digests of exact 4 MiB blocks, not the file SHA-256. */
export async function hashDropboxCapture(
  path: string,
  expected: { sha256: string; byteLength: number },
): Promise<{ sha256: string; byteLength: number; dropboxContentHash: string }> {
  if (
    !HEX.test(expected.sha256) ||
    !Number.isSafeInteger(expected.byteLength) ||
    expected.byteLength < 1 ||
    expected.byteLength > 64 * 1024 * 1024 ||
    !isAbsolute(path) ||
    path !== resolve(path) ||
    (await realpath(path).catch(() => "")) !== path
  )
    fail("capture identity is invalid");
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o022) !== 0 ||
    before.size !== expected.byteLength ||
    !constants.O_NOFOLLOW ||
    !constants.O_NONBLOCK
  )
    fail("capture is not a stable owner file");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const block = Buffer.alloc(4 * 1024 * 1024);
  try {
    const initial = await file.stat();
    if (
      initial.dev !== before.dev ||
      initial.ino !== before.ino ||
      initial.size !== before.size ||
      initial.mtimeMs !== before.mtimeMs ||
      initial.ctimeMs !== before.ctimeMs
    )
      fail("capture changed during open");
    const sha = createHash("sha256");
    const dropbox = createHash("sha256");
    let position = 0;
    while (position < expected.byteLength) {
      const length = Math.min(block.length, expected.byteLength - position);
      let read = 0;
      while (read < length) {
        const result = await file.read(
          block,
          read,
          length - read,
          position + read,
        );
        if (!result.bytesRead) fail("capture changed during read");
        read += result.bytesRead;
      }
      const bytes = block.subarray(0, length);
      sha.update(bytes);
      dropbox.update(createHash("sha256").update(bytes).digest());
      position += length;
    }
    const after = await file.stat();
    if (
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      after.ctimeMs !== initial.ctimeMs ||
      sha.digest("hex") !== expected.sha256
    )
      fail("capture bytes do not match source");
    return { ...expected, dropboxContentHash: dropbox.digest("hex") };
  } finally {
    block.fill(0);
    await file.close();
  }
}

async function api(
  token: string,
  route: "users/get_current_account" | "files/get_metadata",
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.dropboxapi.com/2/${route}`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    fail("provider metadata request failed");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        fail("provider metadata exceeds bound");
      }
      parts.push(part.value);
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("provider metadata is invalid");
    return value as Record<string, unknown>;
  } finally {
    for (const part of parts) part.fill(0);
    reader.releaseLock();
  }
}

function requiredString(
  row: Record<string, unknown>,
  key: string,
  pattern: RegExp,
): string {
  const value = row[key];
  if (typeof value !== "string" || !pattern.test(value))
    fail("provider identity is invalid");
  return value;
}

export async function verifyDropboxOriginal(
  input: DropboxOriginalInput,
): Promise<VerifiedDropboxOriginal> {
  try {
    if (
      ![input.providerAccountIdHash, input.providerRootDirectoryIdHash].every(
        (x) => HEX.test(x),
      ) ||
      !ID.test(input.providerRootDirectoryId) ||
      digest(input.providerRootDirectoryId) !==
        input.providerRootDirectoryIdHash ||
      !UUID.test(input.bindingId) ||
      (input.expectedProviderFileIdHash !== undefined &&
        !HEX.test(input.expectedProviderFileIdHash)) ||
      !input.relativePath ||
      input.relativePath.length > 2048 ||
      /[\\\x00-\x1f\x7f]/.test(input.relativePath) ||
      input.relativePath
        .split("/")
        .some((x) => !x || x === "." || x === ".." || x.trim() !== x)
    )
      fail("provider source binding is invalid");
    const captured = await hashDropboxCapture(input.capturePath, {
      sha256: input.sourceContentHash,
      byteLength: input.sourceByteLength,
    });
    return await withDropboxAccessToken(
      input.credentials,
      input.refreshPath,
      async (token) => {
        const signal = AbortSignal.timeout(30_000);
        const account = await api(
          token,
          "users/get_current_account",
          null,
          signal,
        );
        const accountId = requiredString(
          account,
          "account_id",
          /^dbid:[A-Za-z0-9_-]{1,256}$/,
        );
        if (
          digest(accountId) !== input.providerAccountIdHash ||
          account.disabled !== false
        )
          fail("provider account mismatch");
        const root = await api(
          token,
          "files/get_metadata",
          { path: input.providerRootDirectoryId },
          signal,
        );
        const rootPath = requiredString(
          root,
          "path_lower",
          /^\/[^\x00-\x1f\x7f]{1,2048}$/,
        );
        if (
          root[".tag"] !== "folder" ||
          root.id !== input.providerRootDirectoryId
        )
          fail("provider root mismatch");
        const file = await api(
          token,
          "files/get_metadata",
          { path: `${rootPath}/${input.relativePath}`, include_deleted: false },
          signal,
        );
        const fileId = requiredString(file, "id", ID);
        const revision = requiredString(file, "rev", /^[\x21-\x7e]{1,128}$/);
        const providerHash = requiredString(file, "content_hash", HEX);
        const filePath = requiredString(
          file,
          "path_lower",
          /^\/[^\x00-\x1f\x7f]{1,4096}$/,
        );
        if (
          file[".tag"] !== "file" ||
          file.size !== captured.byteLength ||
          providerHash !== captured.dropboxContentHash ||
          !filePath.startsWith(`${rootPath}/`) ||
          (input.expectedProviderFileIdHash !== undefined &&
            digest(fileId) !== input.expectedProviderFileIdHash)
        )
          fail("provider original does not match captured bytes or binding");
        const finalRoot = await api(
          token,
          "files/get_metadata",
          { path: rootPath },
          signal,
        );
        const finalFile = await api(
          token,
          "files/get_metadata",
          { path: fileId },
          signal,
        );
        if (
          finalRoot[".tag"] !== "folder" ||
          finalRoot.id !== root.id ||
          finalRoot.path_lower !== rootPath ||
          finalFile[".tag"] !== "file" ||
          finalFile.id !== fileId ||
          finalFile.rev !== revision ||
          finalFile.content_hash !== providerHash ||
          finalFile.size !== captured.byteLength ||
          finalFile.path_lower !== filePath
        )
          fail("provider original changed during verification");
        return {
          metadata: {
            referenceVersion: "provider_original_v1",
            providerKind: "dropbox_v1",
            providerAccountIdHash: input.providerAccountIdHash,
            providerRootDirectoryIdHash: input.providerRootDirectoryIdHash,
            providerFileIdHash: digest(fileId),
            providerRevision: revision,
            providerContentHash: providerHash,
            sourceContentHash: captured.sha256,
            sourceByteLength: captured.byteLength,
            verifiedAt: Date.now(),
          },
          binding: {
            bindingId: input.bindingId,
            providerAccountId: accountId,
            providerRootDirectoryId: input.providerRootDirectoryId,
            providerFileId: fileId,
            providerRevision: revision,
            relativePath: input.relativePath,
          },
        };
      },
    );
  } catch (error) {
    if (error instanceof DropboxVerificationError) throw error;
    fail("original verification failed");
  }
}
