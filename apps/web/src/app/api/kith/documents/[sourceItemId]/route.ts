import { noStoreJson } from "@/lib/kith/api-route";
import { authorizedDocument } from "@/lib/kith/document-content";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
    return noStoreJson(found.metadata);
  } catch {
    return noStoreJson({ error: "Document could not be loaded" }, 503);
  }
}
