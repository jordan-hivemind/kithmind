// `DocumentReference` attachment handling: which content types this package
// fetches at all, and which of those get text extracted versus stored as
// bytes to a folder with no extraction (yet).

/** Content types `pull` fetches the `Binary` for at all, per the task. */
const FETCHABLE_CONTENT_TYPES = new Set([
  "text/plain",
  "text/html",
  "application/rtf",
  "text/rtf",
  "application/pdf",
]);

export function isFetchableContentType(contentType: string): boolean {
  return FETCHABLE_CONTENT_TYPES.has(contentType.toLowerCase().split(";")[0]!.trim());
}

/** Text and HTML get text extracted; RTF and PDF are stored as bytes with no
 * extraction (the task specifies this explicitly for PDF; RTF has no text
 * layout parser here either, so it is treated the same way). */
export function extractsText(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(";")[0]!.trim();
  return normalized === "text/plain" || normalized === "text/html";
}

/** A minimal, dependency-free HTML-to-text extraction: strips tags and
 * collapses whitespace. Not a full parser -- Clinical Notes are prose, not
 * markup that needs perfect fidelity, and this is good enough for search and
 * for the owner to read the note's content in the admin screen. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extracts text from a fetched attachment, or null when this content type
 * is stored as bytes only. */
export function extractText(contentType: string, buffer: Buffer): string | null {
  const normalized = contentType.toLowerCase().split(";")[0]!.trim();
  if (normalized === "text/plain") return buffer.toString("utf8");
  if (normalized === "text/html") return stripHtml(buffer.toString("utf8"));
  return null;
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "text/plain": "txt",
  "text/html": "html",
};

/** The filename a fetched attachment is stored under, when it is stored as
 * bytes rather than extracted (PDF and RTF). */
export function storageFileName(fhirId: string, contentType: string): string {
  const normalized = contentType.toLowerCase().split(";")[0]!.trim();
  const extension = EXTENSION_BY_CONTENT_TYPE[normalized] ?? "bin";
  return `${fhirId}.${extension}`;
}
