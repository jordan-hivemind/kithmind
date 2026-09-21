import { noStoreJson } from "@/lib/kith/api-route";
import {
  authorizedDocument,
  documentByteResponse,
  downloadDocumentBytes,
} from "@/lib/kith/document-content";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sourceItemId: string }> },
) {
  try {
    const found = await authorizedDocument(
      request,
      (await params).sourceItemId,
    );
    if (!found)
      return noStoreJson({ error: "Sign in to view this document" }, 401);
    if (!found.document)
      return noStoreJson({ error: "Document not found" }, 404);
    if (!found.config || !found.path || !found.metadata.contentAvailable)
      return noStoreJson(
        { error: "Original file is unavailable; use the retained text" },
        404,
      );
    const bytes = await downloadDocumentBytes(
      found.config,
      found.path,
      found.document.contentHash,
    );
    return documentByteResponse(
      request,
      bytes,
      found.document.title,
      found.metadata.mimeType ?? "application/octet-stream",
    );
  } catch {
    return noStoreJson(
      {
        error:
          "Original file could not be loaded or no longer matches the indexed version. Retained text remains available.",
      },
      503,
    );
  }
}
