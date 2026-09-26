// Where a document added from the Edit investment drawer lands in Dropbox.
//
// The browser uploads the bytes straight to Dropbox through a temporary
// upload link, because a Vercel function refuses a request body over 4.5 MB
// and signed agreements are often larger. The server decides the path; the
// browser only names the file. The hourly ingester then picks the file up
// like any other, and the folder name is what links it to the investment.

import { posix } from "node:path";

import {
  accessToken,
  type DropboxDocumentConfig,
} from "@/lib/kith/document-content";

export const INVESTING_ROOT_ALIAS = "dropbox-investing";

/** A single path segment that Dropbox and the ingester both accept. */
export function safeSegment(value: string): string {
  const cleaned = Array.from(value.normalize("NFC"), (character) => {
    const code = character.charCodeAt(0);
    return /[/\\:*?"<>|]/.test(character) || code <= 31 || code === 127
      ? " "
      : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 180)
    .trim();
  return cleaned;
}

/**
 * The folder under the Investing root for this investment: the one its
 * existing documents already sit in, when most of them share one, else a new
 * folder named for the investment. Existing folders are not always named
 * exactly like the investment, so reusing them keeps one folder per
 * investment.
 */
export function investmentFolder(
  investmentName: string,
  documentUris: readonly (string | null)[],
): string {
  const counts = new Map<string, number>();
  const prefix = `fs://${INVESTING_ROOT_ALIAS}/`;
  for (const uri of documentUris) {
    if (uri === null || !uri.startsWith(prefix)) continue;
    const parts = uri.slice(prefix.length).split("/");
    if (parts.length < 2) continue;
    let folder: string;
    try {
      folder = decodeURIComponent(parts[0]!);
    } catch {
      continue;
    }
    if (safeSegment(folder) !== folder || folder === "") continue;
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0];
  return best?.[0] ?? (safeSegment(investmentName) || "Investment");
}

/** The absolute Dropbox path for the upload, or null when the Investing root
 * is not configured or the file name is unusable. */
export function uploadPath(
  config: DropboxDocumentConfig,
  folder: string,
  filename: string,
): string | null {
  const root = config.roots.find((r) => r.alias === INVESTING_ROOT_ALIAS);
  const name = safeSegment(posix.basename(filename.replaceAll("\\", "/")));
  if (!root || name === "" || folder === "") return null;
  return `${root.path.replace(/\/$/, "")}/${folder}/${name}`;
}

export class UploadUnavailableError extends Error {}

/** A single-use link the browser POSTs the file to. `autorename` keeps an
 * existing file of the same name rather than replacing it. */
export async function temporaryUploadLink(
  config: DropboxDocumentConfig,
  path: string,
): Promise<string> {
  const token = await accessToken(config);
  const response = await fetch(
    "https://api.dropboxapi.com/2/files/get_temporary_upload_link",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        commit_info: { path, mode: "add", autorename: true, mute: true },
        duration: 900,
      }),
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new UploadUnavailableError(
      text.includes("missing_scope") || response.status === 401
        ? "The Dropbox connection is read-only. Reconnect it with write access to add documents."
        : "Dropbox refused the upload",
    );
  }
  const body = (await response.json()) as { link?: string };
  if (!body.link?.startsWith("https://"))
    throw new UploadUnavailableError("Dropbox refused the upload");
  return body.link;
}
