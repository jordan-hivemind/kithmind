// `/api/kith/source-roots`: the sources screen's four writes (ADM-4b).
//
// POST adds a watched folder, PATCH pauses or resumes one, DELETE removes one.
// The read is `GET /api/kith/sources`, which returns the roots beside the
// accounts they hang off, because the screen shows them as one table.
//
// One file for three methods rather than three files, for the reason
// `/api/kith/investments` gives: they are one resource with one validation
// vocabulary.
//
// Who may call them: a signed-in session whose principal is an `owner` or an
// `editor` of the space the row is in, and nobody else. `withPrincipal`
// (lib/kith/api-route.ts) supplies the same-origin check, the JSON content
// type and the reloaded principal inside this request's own transaction; the
// store functions below then resolve the space from the row itself and call
// `requireSpaceAccess(..., "write")` against it, so nothing here passes a
// space id in from the request. A reader, and a member of another space, gets
// the same "not found" a stranger does.
//
// A worker credential cannot reach this route at all: it authenticates with a
// bearer key against `/api/worker`, not with a session cookie, and its own
// path to the same rows is `source.roots` / `source.rootReport`, which are
// scoped to the one source account its key is granted.

import { admin } from "@repo/kith-store";
import { z } from "zod";

import {
  noContent,
  noStoreJson,
  parsedBody,
  withPrincipal,
} from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const kithId = z.string().min(1).max(128);

/**
 * The shape the Add folder dialog posts.
 *
 * The path rule is stated once, in the store
 * (`admin.assertSourceRootLocation`), and this schema deliberately does not
 * restate it: two copies of "no `..`" is one copy that can be wrong. What is
 * here is only the shape and the bounds, so a malformed body is a 400 before a
 * transaction is opened.
 */
const createSchema = z.object({
  sourceAccountId: kithId,
  rootAlias: z.string().min(1).max(64),
  relativePath: z.string().min(1).max(1024),
  area: z.string().trim().min(1).max(100).nullish(),
});

const patchSchema = z.object({
  sourceRootId: kithId,
  state: z.enum(["active", "paused"]),
});

const deleteSchema = z.object({ sourceRootId: kithId });

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, createSchema);
    if ("response" in body) return body.response;
    const id = await admin.upsertSourceRoot(ctx, {
      principal,
      sourceAccountId: body.value.sourceAccountId,
      // The UI adds folders. An institution or a manual source is not
      // something a path names.
      kind: "folder",
      rootAlias: body.value.rootAlias,
      relativePath: body.value.relativePath,
      area: body.value.area ?? null,
    });
    return noStoreJson({ id }, 201);
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, patchSchema);
    if ("response" in body) return body.response;
    await admin.setSourceRootState(ctx, { principal, ...body.value });
    return noContent();
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, deleteSchema);
    if ("response" in body) return body.response;
    await admin.deleteSourceRoot(ctx, { principal, ...body.value });
    return noContent();
  });
}
