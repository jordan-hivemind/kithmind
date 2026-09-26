// `/api/kith/investments/[id]/documents`: the documents the Edit investment
// drawer lists, what the owner does with them, and where a new one goes.
//
// GET lists the investment's linked documents. PATCH confirms a suggested
// link or removes one; removing is the store's rejection, which is remembered
// so the matcher never links that document to this investment again. POST
// names a file and returns a temporary Dropbox upload link for it, under the
// Investing folder the investment's documents already use (see
// `lib/kith/investment-upload.ts`). The browser sends the bytes to Dropbox
// directly and the hourly ingester files them.

import { admin } from "@repo/kith-store";

import {
  noContent,
  noStoreJson,
  parsedBody,
  problem,
  withPrincipal,
  withPrincipalRead,
} from "@/lib/kith/api-route";
import { documentDropboxConfig } from "@/lib/kith/document-content";
import {
  investmentDocumentActionSchema,
  investmentUploadSchema,
} from "@/lib/kith/investment-schemas";
import {
  investmentFolder,
  temporaryUploadLink,
  uploadPath,
  UploadUnavailableError,
} from "@/lib/kith/investment-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  { params }: Params,
): Promise<Response> {
  return withPrincipalRead(request, async ({ ctx, principal }) => {
    const spaces = await admin.getAdminSpaceIds(ctx, principal);
    if (spaces.length === 0) return noStoreJson({ documents: [] });
    const documents = await admin.listInvestmentDocuments(
      ctx,
      spaces,
      (await params).id,
    );
    return noStoreJson({
      // The Dropbox path stays on the server.
      documents: documents.map((document) => ({
        linkId: document.linkId,
        sourceItemId: document.sourceItemId,
        title: document.title,
        kind: document.kind,
        state: document.state,
        entryId: document.entryId,
        capturedAt: document.capturedAt,
      })),
    });
  });
}

export async function PATCH(
  request: Request,
  { params }: Params,
): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, investmentDocumentActionSchema);
    if ("response" in body) return body.response;
    const spaces = await admin.getAdminSpaceIds(ctx, principal);
    if (spaces.length === 0) return problem(404, "Not found");
    // The link must belong to the investment the path names, or the path
    // would be a lie about what changed.
    const [link] = await admin
      .listInvestmentDocumentLinks(ctx, spaces, {
        investmentIds: [(await params).id],
      })
      .then((links) => links.filter((item) => item.id === body.value.linkId));
    if (!link) return problem(404, "Not found");
    if (body.value.action === "confirm") {
      await admin.confirmInvestmentDocumentLink(ctx, {
        principal,
        linkId: link.id,
      });
    } else {
      // A document linked to the investment and to one of its entries shows
      // once in the drawer; removing it removes every live link it has here.
      const siblings = await admin.listInvestmentDocumentLinks(ctx, spaces, {
        investmentIds: [link.investmentId],
        sourceItemId: link.sourceItemId,
      });
      for (const sibling of siblings) {
        if (sibling.state === "rejected") continue;
        await admin.rejectInvestmentDocumentLink(ctx, {
          principal,
          linkId: sibling.id,
        });
      }
    }
    return noContent();
  });
}

export async function POST(
  request: Request,
  { params }: Params,
): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, investmentUploadSchema);
    if ("response" in body) return body.response;
    const spaces = await admin.getAdminSpaceIds(ctx, principal);
    if (spaces.length === 0) return problem(404, "Not found");
    const id = (await params).id;
    const investment = await admin.getInvestment(ctx, spaces, id);
    if (!investment) return problem(404, "Not found");
    const config = documentDropboxConfig();
    if (!config) return problem(503, "Dropbox is not connected");
    const documents = await admin.listInvestmentDocuments(ctx, spaces, id);
    const path = uploadPath(
      config,
      investmentFolder(
        investment.name,
        documents.map((document) => document.uri),
      ),
      body.value.filename,
    );
    if (path === null) return problem(400, "That file cannot be added here");
    try {
      return noStoreJson({
        uploadUrl: await temporaryUploadLink(config, path),
      });
    } catch (error) {
      if (error instanceof UploadUnavailableError)
        return problem(502, error.message);
      throw error;
    }
  });
}
