// The browse page, now a server component that picks a surface.
//
// Under `convex` it renders `ConvexBrowse` verbatim; i7 deletes that path.
// Under `postgres` the view, the history toggle, the type filter and the
// search query are the page's own `?view=&historical=&type=&q=` query string,
// so the whole page (including the "search") is one read-only transaction
// (`loadBrowse`) with no client-side query of its own.

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
  const query = one(params.q);

  const data = await loadBrowse((await headers()).get("cookie"), {
    view,
    includeHistorical,
    ...(type ? { type } : {}),
    ...(query ? { query } : {}),
  });
  if (data === null) redirect("/sign-in");

  return (
    <KithBrowse
      data={data}
      includeHistorical={includeHistorical}
      type={type}
      query={query}
    />
  );
}
