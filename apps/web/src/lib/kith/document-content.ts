import { createHash } from "node:crypto";
import { posix } from "node:path";

import { documents } from "@repo/kith-store";
import { getAuthorizedReadSpaceIds } from "@repo/kith-store/identity";

import { loadAuthenticatedPage } from "./page-session";

export type DocumentMetadata = {
  title: string | null;
  mimeType: string | null;
  contentAvailable: boolean;
  textAvailable: boolean;
  originalUnavailableReason?: string;
  pages: Array<{ pageNumber: number; text: string }>;
};
export type DropboxDocumentConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  expectedAccountIdHash: string;
  roots: Array<{ sourceAccountId: string; alias: string; path: string }>;
};
const MAX_BYTES = 100 * 1024 * 1024;
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function unsafePathCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return character === "\\" || code <= 31 || code === 127;
  });
}

function safeFilename(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || code <= 31 || code === 127
      ? "_"
      : character;
  }).join("");
  return sanitized || "document";
}

export function documentDropboxConfig(): DropboxDocumentConfig | null {
  const raw = process.env.KITH_DOCUMENT_DROPBOX;
  if (!raw) return null;
  try {
    const config = JSON.parse(raw) as DropboxDocumentConfig;
    if (
      ![config.clientId, config.clientSecret, config.refreshToken].every(
        (x) => typeof x === "string" && x.length > 0,
      ) ||
      !/^[a-f0-9]{64}$/.test(config.expectedAccountIdHash) ||
      !Array.isArray(config.roots) ||
      !config.roots.every(
        (r) =>
          typeof r.sourceAccountId === "string" &&
          typeof r.alias === "string" &&
          typeof r.path === "string" &&
          r.path.startsWith("/") &&
          posix.normalize(r.path) === r.path,
      )
    )
      return null;
    return config;
  } catch {
    return null;
  }
}

/** Browser input is a source ID only. Provider paths derive from a stored URI
 * and a connection-scoped server configuration, never a caller-supplied URL. */
export function documentDropboxPath(
  config: DropboxDocumentConfig,
  sourceAccountId: string,
  uri: string | null,
): string | null {
  if (!uri) return null;
  const match = /^fs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) return null;
  const root = config.roots.find(
    (r) => r.sourceAccountId === sourceAccountId && r.alias === match[1],
  );
  if (!root) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  if (
    unsafePathCharacter(relative) ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    return null;
  return `${root.path.replace(/\/$/, "")}/${relative}`;
}

function mimeType(title: string, path: string | null): string {
  const extension = posix.extname(path ?? title).toLowerCase();
  return (
    (
      {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".txt": "text/plain; charset=utf-8",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

type ProviderOriginalDocument = {
  originalLinkAvailable: boolean | null;
  originalRecovery?: {
    kind: string;
    providerVerification?: string;
  };
  contentHash: string;
};

/** A recoverable-looking URI is not sufficient authority to contact a
 * provider. The worker must have admitted an explicit provider-original
 * reference, and the immutable admission audit must still verify. */
export function providerOriginalAvailable(
  document: ProviderOriginalDocument,
  path: string | null,
): boolean {
  return (
    path !== null &&
    document.originalLinkAvailable === true &&
    document.originalRecovery?.kind === "provider_original_v1" &&
    document.originalRecovery.providerVerification === "verified_at_admission" &&
    /^[a-f0-9]{64}$/.test(document.contentHash)
  );
}

export async function authorizedDocument(
  request: Request,
  sourceItemId: string,
) {
  if (!/^[a-z0-9_-]{1,128}$/i.test(sourceItemId)) return null;
  return await loadAuthenticatedPage(
    request.headers.get("cookie"),
    async ({ ctx, principal }) => {
      const spaces = await getAuthorizedReadSpaceIds(ctx, principal);
      const result = await documents.getDocumentsForSourceItem(
        ctx.client,
        spaces,
        sourceItemId,
      );
      const document = result.documents[0];
      if (!document)
        return { document: null, metadata: null, path: null, config: null };
      const config = documentDropboxConfig();
      const path = config
        ? documentDropboxPath(
            config,
            document.sourceAccountId,
            document.originalUri,
          )
        : null;
      const contentAvailable = providerOriginalAvailable(document, path);
      const metadata: DocumentMetadata = {
        title: document.title,
        mimeType: mimeType(document.title, path),
        contentAvailable,
        textAvailable: result.documents.some((d) => d.pages.length > 0),
        ...(!contentAvailable
          ? {
              originalUnavailableReason:
                "Original-file access is not connected for this source. Retained text is available below.",
            }
          : {}),
        pages: result.documents.flatMap((d) =>
          d.pages.map((p) => ({ pageNumber: p.ordinal + 1, text: p.text })),
        ),
      };
      return { document, metadata, path, config };
    },
  );
}

let tokenCache:
  { key: string; until: number; token: Promise<string> } | undefined;
async function accessToken(config: DropboxDocumentConfig): Promise<string> {
  const key = sha256(
    JSON.stringify([
      config.clientId,
      config.clientSecret,
      config.refreshToken,
      config.expectedAccountIdHash,
    ]),
  );
  if (tokenCache?.key === key && tokenCache.until > Date.now())
    return tokenCache.token;
  const token = (async () => {
    const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: config.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
    if (!response.ok)
      throw new Error("Original-file connection could not authenticate");
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token)
      throw new Error("Original-file connection could not authenticate");
    const account = await fetch(
      "https://api.dropboxapi.com/2/users/get_current_account",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${body.access_token}` },
      },
    );
    if (!account.ok)
      throw new Error("Original-file account could not be verified");
    const identity = (await account.json()) as { account_id?: string };
    if (
      !identity.account_id ||
      sha256(identity.account_id) !== config.expectedAccountIdHash
    )
      throw new Error("Original-file account does not match");
    return body.access_token;
  })();
  tokenCache = { key, until: Date.now() + 3 * 60 * 60 * 1000, token };
  try {
    return await token;
  } catch (error) {
    if (tokenCache?.key === key) tokenCache = undefined;
    throw error;
  }
}

export async function downloadDocumentBytes(
  config: DropboxDocumentConfig,
  path: string,
  contentHash: string,
): Promise<Uint8Array> {
  const token = await accessToken(config);
  const response = await fetch(
    "https://content.dropboxapi.com/2/files/download",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path }).replace(
          /[\u007f-\uffff]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        ),
      },
    },
  );
  if (!response.ok || !response.body)
    throw new Error("Original file is unavailable from its source");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES)
        throw new Error("Original file exceeds the viewer's 100 MB limit");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (sha256(bytes) !== contentHash)
    throw new Error(
      "The original file changed since it was indexed. Retained text still matches the reviewed version.",
    );
  return bytes;
}

export function documentByteResponse(
  request: Request,
  bytes: Uint8Array,
  title: string,
  type: string,
): Response {
  const download = new URL(request.url).searchParams.get("download") === "1";
  const safeInline =
    ["application/pdf", "image/png", "image/jpeg"].includes(type) ||
    type.startsWith("text/plain");
  let start = 0,
    end = bytes.length - 1,
    status = 200;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${bytes.length}` },
      });
    if (!match[1]) start = Math.max(0, bytes.length - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (start > end || start >= bytes.length)
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${bytes.length}` },
      });
    status = 206;
  }
  const filename = safeFilename(title);
  let cursor = start;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor > end) {
        controller.close();
        return;
      }
      const next = Math.min(end + 1, cursor + 65536);
      controller.enqueue(bytes.subarray(cursor, next));
      cursor = next;
    },
  });
  return new Response(stream, {
    status,
    headers: {
      ...headers,
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${download || !safeInline ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`,
      ...(status === 206
        ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` }
        : {}),
    },
  });
}
