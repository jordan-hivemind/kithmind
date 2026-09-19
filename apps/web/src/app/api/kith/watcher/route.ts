// `/api/kith/watcher`: the health screen's one write (ADM-10).
//
// POST re-registers a source account's filesystem watcher: it clears the
// registered watcher id so the next heartbeat claims the source again. It is
// the supported way out of `identity_review_required`, and the store function
// behind it (`workers.reregisterWorkerWatcher`) explains why it is the only
// one -- a worker may not approve its own identity mapping, so there is no
// worker-side subcommand that does this.
//
// Who may call it: a signed-in session whose principal is an `owner` of the
// space the source account is in, and nobody else. `withPrincipal`
// (lib/kith/api-route.ts) supplies the same-origin check, the JSON content
// type and the reloaded principal inside this request's own transaction; the
// store function then resolves the space from the account row itself and
// requires `write` and then the `owner` role against it, so no space id is
// passed in from the request. An editor and a reader get the same "not found"
// a stranger does.
//
// A worker credential cannot reach this route at all: it authenticates with a
// bearer key against `/api/worker`, not with a session cookie.

import { workers } from "@repo/kith-store";
import { z } from "zod";

import { noStoreJson, parsedBody, withPrincipal } from "@/lib/kith/api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `requestId` is the caller's idempotency key, the same one
 * `resetWorkerWatcher` has always taken: a retried click replays its receipt
 * instead of clearing a registration the first click already replaced.
 */
const schema = z.object({
  sourceAccountId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
});

export async function POST(request: Request): Promise<Response> {
  const body = await parsedBody(request, schema);
  if ("response" in body) return body.response;
  return withPrincipal(request, async ({ ctx, principal }) =>
    noStoreJson(
      await workers.reregisterWorkerWatcher(
        ctx,
        {
          userId: principal.userId,
          ...(principal.credentialId
            ? { credentialId: principal.credentialId }
            : {}),
        },
        body.value,
      ),
    ),
  );
}
