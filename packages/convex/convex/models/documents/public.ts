import { query } from "../../_generated/server";

import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { requireWebPrincipal } from "../../lib/webAuth";
import {
  getDocument,
  listSources as listSourceRecords,
  searchDocuments,
} from "./model";
import {
  documentGetArgs,
  documentSearchArgs,
  sourceListArgs,
} from "./validators";

export const search = query({
  args: documentSearchArgs,
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await searchDocuments(ctx, spaceIds, args);
  },
});

export const get = query({
  args: documentGetArgs,
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await getDocument(
      ctx,
      spaceIds,
      args.documentId,
      args.includeHistorical,
    );
  },
});

export const listSources = query({
  args: sourceListArgs,
  handler: async (ctx, args) => {
    const principal = await requireWebPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    return await listSourceRecords(ctx, spaceIds, args);
  },
});
