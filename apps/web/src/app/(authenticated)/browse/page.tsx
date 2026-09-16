// The browse page, now a server component that picks a surface.
//
// Under `convex` it renders `ConvexBrowse` verbatim; i7 deletes that path.
// Under `postgres` the view, the history toggle and the type filter are the
// page's own `?view=&historical=&type=` query string, so the default render
// is one read-only transaction (`loadBrowse`). The thoughts tab's free-text
// search is not part of this query string -- see `lib/kith/browse.ts` and
// `components/kith-thought-search.tsx` -- so it never reaches this page's
// `searchParams` at all.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ConvexBrowse } from "@/components/convex-browse";
import { KithBrowse } from "@/components/kith-browse";
import { loadBrowse } from "@/lib/kith/browse";
import { kithPostgresSurface } from "@/lib/kith/surface";

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (kithPostgresSurface() !== "postgres") return <ConvexBrowse />;

  const params = await searchParams;
  const view = one(params.view) === "thoughts" ? "thoughts" : "facts";
  const includeHistorical = one(params.historical) === "1";
  const type = one(params.type);

  const data = await loadBrowse((await headers()).get("cookie"), {
    view,
    includeHistorical,
    ...(type ? { type } : {}),
  });
  if (data === null) redirect("/sign-in");

  return (
    <KithBrowse data={data} includeHistorical={includeHistorical} type={type} />
  );
}
