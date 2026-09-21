// `/api/kith/source-roots`: the sources screen's four writes (ADM-4b).
//
// POST adds a watched folder, PATCH pauses or resumes one, DELETE retires one
// (the row and its reports stay; it leaves the screen and the watcher's list).
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
  problem,
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
  state: z.enum(["active", "paused"]).optional(),
  rootAlias: z.string().min(1).max(64).optional(),
  relativePath: z.string().min(1).max(1024).optional(),
  area: z.string().trim().min(1).max(100).nullable().optional(),
});

/** DELETE retires: the row and its reports stay. See `retireSourceRoot`. */
const retireSchema = z.object({ sourceRootId: kithId });

/**
 * Add a folder, or answer that it is already watched.
 *
 * `201` with `created: true` for a folder this space was not watching, `200`
 * with `created: false` for one it already was. The second writes nothing the
 * caller did not name: it does not clear the provider folder id the watcher
 * resolved, does not clear an area the dialog left blank, and does not resume
 * a paused folder (see `upsertSourceRoot`). A retired folder is the one thing
 * re-adding does revive, because that is what re-adding a removed folder has
 * to mean.
 *
 * `area` is forwarded only when the request carried one, so "add the folder I
 * am already watching" is not also "clear its area".
 */
export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, createSchema);
    if ("response" in body) return body.response;
    const result = await admin.upsertSourceRoot(ctx, {
      principal,
      sourceAccountId: body.value.sourceAccountId,
      // The UI adds folders. An institution or a manual source is not
      // something a path names.
      kind: "folder",
      rootAlias: body.value.rootAlias,
      relativePath: body.value.relativePath,
      ...(body.value.area === undefined || body.value.area === null
        ? {}
        : { area: body.value.area }),
    });
    return noStoreJson(result, result.created ? 201 : 200);
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, patchSchema);
    if ("response" in body) return body.response;
    if (body.value.state !== undefined) {
      if (
        body.value.rootAlias !== undefined ||
        body.value.relativePath !== undefined ||
        body.value.area !== undefined
      )
        return problem(400, "Invalid request");
      await admin.setSourceRootState(ctx, {
        principal,
        sourceRootId: body.value.sourceRootId,
        state: body.value.state,
      });
    } else if (
      body.value.rootAlias !== undefined &&
      body.value.relativePath !== undefined
    ) {
      await admin.editSourceRoot(ctx, {
        principal,
        ...body.value,
        rootAlias: body.value.rootAlias,
        relativePath: body.value.relativePath,
      });
    } else return problem(400, "Invalid request");
    return noContent();
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return withPrincipal(request, async ({ ctx, principal }) => {
    const body = await parsedBody(request, retireSchema);
    if ("response" in body) return body.response;
    await admin.retireSourceRoot(ctx, { principal, ...body.value });
    return noContent();
  });
}
