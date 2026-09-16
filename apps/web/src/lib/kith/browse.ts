// The browse page's data, on PostgreSQL.
//
// Facts come from `memory.listFacts`. Thoughts come from `memory.listBySpaces`
// when there is no search query, and from `embeddings.searchThoughtsHybrid`
// when there is. The search leg runs with no injected `embedQuery`, so it is
// keyword-only here: section 4.4's two-transaction shape for a vector-backed
// tool is worth paying at an MCP call, where a client waits on one round trip
// either way, and is not worth paying at a page load, where it would mean a
// second read-only transaction and an outbound embedding request on every
// search keystroke's form submission. `vectorStatus` therefore always reads
// `"unavailable"` here; the MCP `search_thoughts` tool is still the full
// hybrid search. This is a deliberate scope line for i5, not a parity bug --
// see the i5 report for the follow-up.

import { embeddings, memory } from "@repo/kith-store";
import { getAuthorizedReadSpaceIds } from "@repo/kith-store/identity";

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
type ThoughtType = (typeof THOUGHT_TYPES)[number];

function asThoughtType(value: string | undefined): ThoughtType | undefined {
  return THOUGHT_TYPES.includes(value as ThoughtType)
    ? (value as ThoughtType)
    : undefined;
}

const LIST_LIMIT = 50;

export type BrowseArgs = {
  view: BrowseView;
  includeHistorical: boolean;
  type?: string;
  query?: string;
};

export type BrowseData =
  | { view: "facts"; facts: memory.HydratedFact[] }
  | {
      view: "thoughts";
      thoughts: readonly (memory.Thought & { score?: number })[];
      searching: boolean;
    };

export async function loadBrowse(
  cookieHeader: string | null,
  args: BrowseArgs,
): Promise<BrowseData | null> {
  return await loadAuthenticatedPage(cookieHeader, async ({ ctx, principal }) => {
    const spaceIds = await getAuthorizedReadSpaceIds(ctx, principal);
    if (args.view === "facts") {
      const facts = await memory.listFacts(ctx, spaceIds, {
        limit: LIST_LIMIT,
        includeHistorical: args.includeHistorical,
      });
      return { view: "facts", facts };
    }

    const type = asThoughtType(args.type);
    const query = args.query?.trim();
    if (query) {
      const found = await embeddings.searchThoughtsHybrid(ctx, spaceIds, query, {
        limit: LIST_LIMIT,
        includeHistorical: args.includeHistorical,
        ...(type === undefined ? {} : { type }),
      });
      return { view: "thoughts", thoughts: found.results, searching: true };
    }
    const thoughts = await memory.listBySpaces(
      ctx,
      spaceIds,
      LIST_LIMIT,
      args.includeHistorical,
      type === undefined ? undefined : { type },
    );
    return { view: "thoughts", thoughts, searching: false };
  });
}
