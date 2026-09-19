// `GET /api/kith/changes?since=<id>`: the change feed of section 4 of
// docs/plans/2026-09-18-admin-panel-and-ingestion.md, as server-sent events or
// as a plain JSON poll with the same cursor.
//
// This is access-control code, so it is deliberately small and says its rules
// once each:
//
//   * Every read is authenticated for itself. `readChanges` below opens one
//     short read transaction, reloads the principal from the cookie inside it
//     with `requireWebPrincipal`, and resolves the authorized space set with
//     `getAuthorizedReadSpaceIds`. The stream calls it again on every tick, so
//     a session revoked mid-stream ends the stream rather than being trusted
//     for as long as the connection happens to live.
//   * The space set is the one the server resolved, never one the request
//     named. There is no `spaceIds` parameter here at all, so there is nothing
//     to widen.
//   * A response carries ids only: the change id, the table name, the row id
//     and the operation. Never row content. A caller therefore learns nothing
//     from this route that reading the named table would not already tell
//     them, and a change row for a space they cannot read never reaches the
//     statement in the first place (`spacePredicate`, which refuses an empty
//     set rather than matching everything).
//   * The gate is `guardedRequest`, shared with every other `/api/kith/*`
//     route: same-origin plus `Content-Type: application/json`. That rules out
//     `EventSource`, which cannot set headers, so the client opens this with
//     `fetch` and reads the body stream (`lib/kith/use-live-changes.ts`).
//     Trading the browser's built-in reconnect for the CSRF barrier every
//     other route has is the right way round.
//
// No transaction is held open across the stream. `createKithPool` bounds this
// instance to two connections (section 2.8 of the consolidation plan), so a
// stream that held one for its whole life would starve every other request on
// the instance. Each tick borrows one for a single statement instead.

import { admin, withKithReadTransaction } from "@repo/kith-store";
import {
  getAuthorizedReadSpaceIds,
  identityCtx,
  requireWebPrincipal,
} from "@repo/kith-store/identity";

import { guardedRequest, mutationFailure, noStoreJson, problem } from "@/lib/kith/api-route";
import { kithNow } from "@/lib/kith/clock";
import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

// Node, not edge: `pg` is a Node driver and `next.config.js` already keeps it
// out of the bundler for that reason.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The platform's own ceiling on this function. The stream ends well before it
 * (`STREAM_BUDGET_MS`), so the client always closes on a cursor it was given
 * rather than on a connection the platform cut.
 */
export const maxDuration = 30;

/** How long one stream lives before it ends cleanly and the client reopens. */
const STREAM_BUDGET_MS = 25_000;
/** How often the stream looks for new changes. */
const POLL_INTERVAL_MS = 2_000;
/** How long the stream may stay silent before it sends a comment. */
const HEARTBEAT_INTERVAL_MS = 15_000;

export type ChangesPayload = {
  cursor: string;
  changes: admin.ChangeRow[];
};

/** A cursor is a decimal `bigint`, or absent. Anything else is refused. */
function parseCursor(value: string | null): string | null | undefined {
  if (value === null || value === "") return null;
  return /^\d{1,19}$/.test(value) ? value : undefined;
}

/**
 * One authenticated read: the changes past `since`, and the cursor to use
 * next.
 *
 * A caller with no authorized spaces gets an empty page and its own cursor
 * back, not an error: it is signed in, it simply has nothing to watch.
 */
async function readChanges(
  request: Request,
  since: string | null,
): Promise<ChangesPayload> {
  const config = kithSessionConfig();
  return await withKithReadTransaction(kithPool(), async (client) => {
    const ctx = identityCtx(client, kithNow());
    const principal = await requireWebPrincipal(ctx, {
      config,
      cookieHeader: request.headers.get("cookie"),
    });
    const spaceIds = await getAuthorizedReadSpaceIds(ctx, principal);
    if (spaceIds.length === 0) return { cursor: since ?? "0", changes: [] };
    // No cursor means "start from now": the client is about to fetch every
    // query it cares about anyway, so replaying three days of retained
    // changes at it would only invalidate what it is already loading.
    if (since === null) {
      return { cursor: await admin.latestChangeId(ctx, spaceIds), changes: [] };
    }
    const changes = await admin.listChangesSince(ctx, spaceIds, since);
    return { cursor: changes.at(-1)?.id ?? since, changes };
  });
}

function sse(payload: ChangesPayload): string {
  return payload.changes
    .map(
      (change) =>
        `id: ${change.id}\nevent: change\ndata: ${JSON.stringify({
          table: change.table,
          rowId: change.rowId,
          op: change.op,
        })}\n\n`,
    )
    .join("");
}

function stream(request: Request, first: ChangesPayload): Response {
  const encoder = new TextEncoder();
  const started = Date.now();
  let cursor = first.cursor;
  let lastSentAt = started;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        controller.enqueue(encoder.encode(text));
        lastSentAt = Date.now();
      };
      // The opening comment flushes headers and any proxy's buffer, and the
      // retry hint is what a client that fell back to polling uses as its
      // interval.
      send(`retry: ${POLL_INTERVAL_MS}\n: open\n\n`);
      if (first.changes.length > 0) send(sse(first));
      try {
        while (
          !request.signal.aborted &&
          Date.now() - started < STREAM_BUDGET_MS
        ) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          if (request.signal.aborted) break;
          const next = await readChanges(request, cursor);
          cursor = next.cursor;
          if (next.changes.length > 0) send(sse(next));
          else if (Date.now() - lastSentAt >= HEARTBEAT_INTERVAL_MS) {
            send(": heartbeat\n\n");
          }
        }
        // The cursor the client resumes from, so a clean end loses nothing.
        if (!request.signal.aborted) {
          send(`id: ${cursor}\nevent: end\ndata: {}\n\n`);
        }
      } catch {
        // A failed tick (a revoked session, a database blip) ends the stream.
        // The client reconnects and gets the real status code then, with a
        // body it can act on, rather than a half-described error mid-stream.
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Tells a buffering proxy to pass bytes through as they arrive.
      "X-Accel-Buffering": "no",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const guarded = guardedRequest(request);
  if (guarded) return guarded;
  const since = parseCursor(new URL(request.url).searchParams.get("since"));
  if (since === undefined) return problem(400, "Invalid cursor", "invalid_cursor");
  let first: ChangesPayload;
  try {
    first = await readChanges(request, since);
  } catch (error) {
    return mutationFailure(error);
  }
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/event-stream")
    ? stream(request, first)
    : noStoreJson(first);
}
