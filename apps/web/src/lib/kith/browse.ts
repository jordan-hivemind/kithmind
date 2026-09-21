// The browse page's data, on PostgreSQL.
//
// Facts come from `memory.listFacts`. The default thoughts listing (no
// search) comes from `memory.listBySpaces` and is part of the page's own
// server-rendered read transaction (`loadBrowse`). Search is not: it used to
// travel as `?q=` on this page's own URL, where it would reach the browser's
// history, any platform access log, and the `Referer` header of whatever the
// results linked to -- none of which the Convex version ever exposed the
// search text to. `searchThoughtsScoped` below is called from
// `app/api/kith/thoughts/search/route.ts` instead, over a `POST` body, and
// `loadBrowse` no longer takes a query at all.
//
// The search leg runs with no injected `embedQuery`, so it is keyword-only:
// section 4.4's two-transaction shape for a vector-backed tool is worth
// paying at an MCP call, where a client waits on one round trip either way,
// and is not worth paying on every search request from this page. The
// PostgreSQL browse page therefore always renders a fixed note next to the
// search box saying so (`components/kith-thought-search.tsx`); the MCP
// `search_thoughts` tool is still the full hybrid search. This is a
// deliberate scope line for i5, not a parity bug -- see the i5 report for
// the follow-up.

import { embeddings, memory } from "@repo/kith-store";
import {
  getAuthorizedReadSpaceIds,
  type IdentityCtx,
} from "@repo/kith-store/identity";

import { loadAuthenticatedPage } from "@/lib/kith/page-session";

export type BrowseView = "facts" | "thoughts";

const THOUGHT_TYPES = [
  "decision",
  "person_note",
  "idea",
  "meeting_note",
  "task",
  "reference",
] as const;
export type ThoughtType = (typeof THOUGHT_TYPES)[number];

export function asThoughtType(
  value: string | undefined,
): ThoughtType | undefined {
  return THOUGHT_TYPES.includes(value as ThoughtType)
    ? (value as ThoughtType)
    : undefined;
}

const LIST_LIMIT = 50;

export type BrowseArgs = {
  view: BrowseView;
  includeHistorical: boolean;
  type?: string;
};

export type BrowseData =
  | {
      view: "facts";
      facts: memory.HydratedFact[];
      stats: memory.SpaceStats;
    }
  | {
      view: "thoughts";
      thoughts: readonly memory.Thought[];
      stats: memory.SpaceStats;
    };

export async function loadBrowse(
  cookieHeader: string | null,
  args: BrowseArgs,
): Promise<BrowseData | null> {
  return await loadAuthenticatedPage(
    cookieHeader,
    async ({ ctx, principal }) => {
      const spaceIds = await getAuthorizedReadSpaceIds(ctx, principal);
      const stats = await memory.computeSpaceStats(ctx, spaceIds);
      if (args.view === "facts") {
        const facts = await memory.listFacts(ctx, spaceIds, {
          limit: LIST_LIMIT,
          includeHistorical: args.includeHistorical,
        });
        return { view: "facts", facts, stats };
      }

      const type = asThoughtType(args.type);
      const thoughts = await memory.listBySpaces(
        ctx,
        spaceIds,
        LIST_LIMIT,
        args.includeHistorical,
        type === undefined ? undefined : { type },
      );
      return { view: "thoughts", thoughts, stats };
    },
  );
}

export type ThoughtSearchResult = {
  thoughts: readonly (memory.Thought & { score: number })[];
  vectorStatus: "ready" | "unavailable";
};

export type ThoughtSearchArgs = {
  query: string;
  includeHistorical: boolean;
  type?: string;
};

/**
 * The keyword-only search behind `POST /api/kith/thoughts/search`. Kept here
 * rather than inline in the route so the "no `embedQuery`" decision and its
 * reasoning live with the rest of this page's data logic, and so
 * `postgres-pages.test.ts` can exercise it the same way it exercises
 * `loadBrowse`. `ctx` and `spaceIds` are the caller's, already reloaded and
 * authorized inside the route's own `withPrincipalRead` transaction.
 */
export async function searchThoughtsScoped(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  args: ThoughtSearchArgs,
): Promise<ThoughtSearchResult> {
  const type = asThoughtType(args.type);
  const found = await embeddings.searchThoughtsHybrid(
    ctx,
    spaceIds,
    args.query,
    {
      limit: LIST_LIMIT,
      includeHistorical: args.includeHistorical,
      ...(type === undefined ? {} : { type }),
    },
  );
  return { thoughts: found.results, vectorStatus: found.vectorStatus };
}
