import { createHash } from "node:crypto";

import {
  DropboxVerificationError,
  withDropboxAccessToken,
  type DropboxCredentialConfig,
} from "./dropboxCredentials.js";
import type {
  ArchiveRelocationProvider,
  RelocationFolder,
} from "./archiveRelocationWorkflow.js";

const ID = /^id:[A-Za-z0-9_-]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PATH = /^\/[^\0-\x1f\x7f]{1,2048}$/;
const NAME = /^[^/\\\0-\x1f\x7f]{1,256}$/;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export type DropboxRelocationProviderInput = Readonly<{
  credentials: DropboxCredentialConfig;
  refreshPath: string;
  expectedAccountIdHash: string;
}>;

type WithAccessToken = <T>(
  config: DropboxCredentialConfig,
  refreshPath: string,
  use: (token: string) => Promise<T>,
) => Promise<T>;
type Fetch = typeof fetch;

function fail(message: string): never {
  throw new DropboxVerificationError(message);
}

/** A namespace-root identity bound to the verified Dropbox account hash. */
export function dropboxNamespaceRootId(expectedAccountIdHash: string): string {
  if (!SHA256.test(expectedAccountIdHash))
    fail("provider account binding is invalid");
  return `dropbox-namespace-root:${expectedAccountIdHash}`;
}

function rawFolder(value: unknown): Omit<RelocationFolder, "parentId"> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("provider folder metadata is invalid");
  const row = value as Record<string, unknown>;
  const { id, name } = row;
  // path_display retains the exact components which workflow boundaries use.
  const path = row.path_display;
  if (
    row[".tag"] !== "folder" ||
    typeof id !== "string" ||
    !ID.test(id) ||
    typeof name !== "string" ||
    !NAME.test(name) ||
    typeof path !== "string" ||
    !PATH.test(path)
  )
    fail("provider folder metadata is invalid");
  return { id, name, path };
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return "/";
  return path.slice(0, index);
}

async function json(
  fetcher: Fetch,
  token: string,
  route:
    | "users/get_current_account"
    | "files/get_metadata"
    | "files/list_folder"
    | "files/move_v2",
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`https://api.dropboxapi.com/2/${route}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    fail("provider relocation request failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        fail("provider relocation response exceeds bound");
      }
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("provider relocation response is invalid");
    return value as Record<string, unknown>;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

/**
 * Adapter for the generic relocation workflow. The caller must hold its
 * workflow lease for the whole prepare/resume sequence. Dropbox supplies no
 * normal metadata ID for the namespace root, so callers use the account-bound
 * sentinel returned by dropboxNamespaceRootId() for that one parent.
 */
export function createDropboxRelocationProvider(
  input: DropboxRelocationProviderInput,
  adapters: { withAccessToken?: WithAccessToken; fetch?: Fetch } = {},
): ArchiveRelocationProvider {
  const namespaceRootId = dropboxNamespaceRootId(input.expectedAccountIdHash);
  const access = adapters.withAccessToken ?? withDropboxAccessToken;
  const fetcher = adapters.fetch ?? fetch;

  const withAccount = async <T>(use: (token: string) => Promise<T>) =>
    await access(input.credentials, input.refreshPath, async (token) => {
      const account = await json(
        fetcher,
        token,
        "users/get_current_account",
        null,
      );
      if (
        typeof account.account_id !== "string" ||
        !/^dbid:[A-Za-z0-9_-]{1,256}$/.test(account.account_id) ||
        account.disabled !== false ||
        digest(account.account_id) !== input.expectedAccountIdHash
      )
        fail("provider account mismatch");
      return await use(token);
    });

  const readFolder = async (
    token: string,
    id: string,
  ): Promise<RelocationFolder> => {
    if (id === namespaceRootId)
      return { id, parentId: id, name: "Dropbox namespace root", path: "/" };
    if (!ID.test(id)) fail("provider folder identity is invalid");
    const current = rawFolder(
      await json(fetcher, token, "files/get_metadata", {
        path: id,
        include_deleted: false,
      }),
    );
    const directParentPath = parentPath(current.path);
    if (directParentPath === "/")
      return { ...current, parentId: namespaceRootId };
    const parent = rawFolder(
      await json(fetcher, token, "files/get_metadata", {
        path: directParentPath,
        include_deleted: false,
      }),
    );
    return { ...current, parentId: parent.id };
  };

  return {
    async getFolder(id) {
      return await withAccount(async (token) => await readFolder(token, id));
    },
    async getChild(parentId, name) {
      if (!NAME.test(name)) fail("provider child lookup is invalid");
      return await withAccount(async (token) => {
        const parent = await readFolder(token, parentId);
        const listing = await json(fetcher, token, "files/list_folder", {
          path: parentId === namespaceRootId ? "" : parent.id,
          recursive: false,
          include_deleted: false,
          include_has_explicit_shared_members: false,
          include_mounted_folders: true,
          limit: 128,
        });
        if (
          !Array.isArray(listing.entries) ||
          listing.entries.length > 128 ||
          listing.has_more !== false
        )
          fail("provider child listing is incomplete");
        const matches: RelocationFolder[] = [];
        for (const entry of listing.entries) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            fail("provider child listing is invalid");
          const row = entry as Record<string, unknown>;
          if (row.name !== name) continue;
          matches.push({ ...rawFolder(row), parentId: parent.id });
        }
        if (matches.length > 1) fail("provider child lookup is ambiguous");
        return matches[0];
      });
    },
    async moveFolder(request) {
      if (
        !ID.test(request.sourceId) ||
        !NAME.test(request.destinationName) ||
        (request.expectedSourceParentId !== namespaceRootId &&
          !ID.test(request.expectedSourceParentId)) ||
        (request.destinationParentId !== namespaceRootId &&
          !ID.test(request.destinationParentId))
      )
        fail("provider move request is invalid");
      return await withAccount(async (token) => {
        const [source, destinationParent] = await Promise.all([
          readFolder(token, request.sourceId),
          readFolder(token, request.destinationParentId),
        ]);
        if (source.parentId !== request.expectedSourceParentId)
          fail("provider source parent changed");
        // Dropbox documents ID-relative child paths as id:<parent>/<child>.
        const target = `${destinationParent.id}/${request.destinationName}`;
        const result = await json(fetcher, token, "files/move_v2", {
          from_path: request.sourceId,
          to_path: target,
          autorename: false,
          allow_ownership_transfer: false,
        });
        if (!result.metadata) fail("provider move result is invalid");
        const responseFolder = rawFolder(result.metadata);
        if (
          responseFolder.id !== request.sourceId ||
          responseFolder.name !== request.destinationName
        )
          fail("provider move result is invalid");
        const moved = await readFolder(token, request.sourceId);
        if (
          moved.parentId !== request.destinationParentId ||
          moved.name !== request.destinationName ||
          moved.path !== `${destinationParent.path}/${request.destinationName}`
        )
          fail("provider move verification failed");
        return moved;
      });
    },
  };
}
